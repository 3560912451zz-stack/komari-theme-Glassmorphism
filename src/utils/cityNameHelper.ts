const CJK_UNIFIED_IDEOGRAPH_REGEX = /\p{Script=Han}/u
const CITY_WHITESPACE_REGEX = /\s+/g
const COUNTRY_CODE_REGEX = /^[A-Z]{2}$/
const CITY_TRANSLATION_TIMEOUT_MS = 1800
const CITY_TRANSLATION_FAILURE_TTL_MS = 5 * 60 * 1000
export const CITY_TRANSLATION_CACHE_MAX_SIZE = 512

const PRESERVE_CITY_NAME_KEYS = new Set(['middle'])

interface TranslationCacheEntry {
  value: string | null
  expiresAt: number
}

export interface CityTranslationCachePayload {
  v: 1
  entries: Record<string, string>
}

const translationCache = new Map<string, TranslationCacheEntry>()
const persistentTranslationCache = new Map<string, string>()
const serverTranslationCache = new Map<string, string>()
const pendingTranslationCache = new Map<string, string>()
const translationInflight = new Map<string, Promise<string | null>>()
let translationCacheScope: string | null = null
let translationCacheScopeInitialized = false
let translationCacheScopeGeneration = 0

function isChineseText(value: string): boolean {
  return CJK_UNIFIED_IDEOGRAPH_REGEX.test(value)
}

function normalizeTranslationKey(value: string): string {
  return value
    .normalize('NFKC')
    .replace(CITY_WHITESPACE_REGEX, ' ')
    .trim()
    .toLocaleLowerCase()
}

function normalizeCountryCode(value: string | null | undefined): string {
  const normalized = value?.trim().toUpperCase() ?? ''
  return COUNTRY_CODE_REGEX.test(normalized) ? normalized : '??'
}

/** Build a stable, country-aware key so identical city names in different countries do not collide. */
export function normalizeCityTranslationKey(countryCode: string | null | undefined, city: string): string {
  const normalizedCity = normalizeTranslationKey(city).replaceAll('|', ' ')
  return `${normalizeCountryCode(countryCode)}|${normalizedCity}`
}

function shouldPreserveOriginalCityName(city: string): boolean {
  return PRESERVE_CITY_NAME_KEYS.has(normalizeTranslationKey(city))
}

function cacheValue(value: string, key: string): void {
  translationCache.set(key, { value, expiresAt: Number.POSITIVE_INFINITY })
}

function rememberFailedTranslation(key: string, scopeGeneration = translationCacheScopeGeneration): void {
  if (scopeGeneration !== translationCacheScopeGeneration)
    return

  translationCache.set(key, {
    value: null,
    expiresAt: Date.now() + CITY_TRANSLATION_FAILURE_TTL_MS,
  })
}

function trimCache(entries: Map<string, string>): void {
  while (entries.size > CITY_TRANSLATION_CACHE_MAX_SIZE)
    entries.delete(entries.keys().next().value as string)
}

function trimPendingTranslationCache(): void {
  while (pendingTranslationCache.size > CITY_TRANSLATION_CACHE_MAX_SIZE) {
    const oldestKey = pendingTranslationCache.keys().next().value
    if (typeof oldestKey !== 'string')
      break

    pendingTranslationCache.delete(oldestKey)
    const serverValue = serverTranslationCache.get(oldestKey)
    if (serverValue !== undefined) {
      persistentTranslationCache.delete(oldestKey)
      persistentTranslationCache.set(oldestKey, serverValue)
      cacheValue(serverValue, oldestKey)
    }
    else {
      persistentTranslationCache.delete(oldestKey)
      translationCache.delete(oldestKey)
    }
  }
}

function normalizeStoredTranslationKey(value: string): string {
  const separator = value.indexOf('|')
  if (separator > 0 && !value.slice(separator + 1).trim())
    return ''
  return separator > 0
    ? normalizeCityTranslationKey(value.slice(0, separator), value.slice(separator + 1))
    : value.trim()
}

function normalizeCacheEntries(raw: unknown): Map<string, string> {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    }
    catch {
      return new Map()
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value))
    return new Map()

  const record = value as Record<string, unknown>
  const source = record.entries && typeof record.entries === 'object' && !Array.isArray(record.entries)
    ? record.entries as Record<string, unknown>
    : record
  const entries = new Map<string, string>()

  for (const [key, translated] of Object.entries(source)) {
    if (key === 'v' || typeof translated !== 'string')
      continue
    const normalized = translated.trim()
    const normalizedKey = normalizeStoredTranslationKey(key)
    if (!normalizedKey || !normalized || !isChineseText(normalized))
      continue
    entries.set(normalizedKey, normalized)
  }

  trimCache(entries)
  return entries
}

/** Parse the JSON value stored in the managed theme setting. */
export function parseCityTranslationCache(raw: unknown): Map<string, string> {
  return normalizeCacheEntries(raw)
}

/** Serialize only validated city translations; no IP, node or coordinate data is persisted. */
export function serializeCityTranslationCache(entries: ReadonlyMap<string, string> | Record<string, string>): string {
  const normalized = new Map<string, string>()
  const source = entries instanceof Map ? entries.entries() : Object.entries(entries)
  for (const [key, translated] of source) {
    const value = translated.trim()
    if (key.trim() && value && isChineseText(value))
      normalized.set(key.trim(), value)
  }
  trimCache(normalized)

  const orderedEntries = Object.fromEntries([...normalized.entries()].sort(([left], [right]) => left.localeCompare(right)))
  const payload: CityTranslationCachePayload = { v: 1, entries: orderedEntries }
  return JSON.stringify(payload)
}

/** Load server-provided translations into the current page session. */
export function hydrateCityTranslationCache(raw: unknown, scope?: string | null): void {
  const nextScope = scope?.trim() || null
  const scopeChanged = translationCacheScopeInitialized && nextScope !== translationCacheScope
  if (scopeChanged) {
    // A module can survive a theme/site switch in an SPA. Never carry entries
    // discovered under the previous scope into the next server's settings.
    pendingTranslationCache.clear()
    translationCacheScopeGeneration += 1
  }

  translationCacheScope = nextScope
  translationCacheScopeInitialized = true
  const entries = parseCityTranslationCache(raw)
  serverTranslationCache.clear()
  for (const [key, value] of entries)
    serverTranslationCache.set(key, value)

  persistentTranslationCache.clear()
  translationCache.clear()

  for (const [key, value] of entries) {
    persistentTranslationCache.set(key, value)
    cacheValue(value, key)
  }

  if (!scopeChanged) {
    // A translation discovered locally while the settings request was in flight is
    // newer than the old server snapshot and must remain available for this scope.
    for (const [key, value] of pendingTranslationCache) {
      persistentTranslationCache.delete(key)
      persistentTranslationCache.set(key, value)
      cacheValue(value, key)
    }
  }
  trimCache(persistentTranslationCache)
  trimPendingTranslationCache()
}

/** Merge a fresh server snapshot with one immutable batch of locally discovered translations. */
export function mergeCityTranslationCache(raw: unknown, additions: ReadonlyMap<string, string>): Map<string, string> {
  const merged = parseCityTranslationCache(raw)
  for (const [key, value] of additions) {
    // Move local additions to the newest end of the bounded map so trimming
    // cannot discard a pending key that must be confirmed after the write.
    merged.delete(key)
    merged.set(key, value)
  }
  trimCache(merged)
  return merged
}

export function getCityTranslationCacheEntries(): Map<string, string> {
  return new Map(persistentTranslationCache)
}

export function getPendingCityTranslationEntries(): Map<string, string> {
  return new Map(pendingTranslationCache)
}

export function acknowledgeCityTranslationEntries(entries: ReadonlyMap<string, string>): void {
  for (const [key, value] of entries) {
    if (pendingTranslationCache.get(key) === value) {
      pendingTranslationCache.delete(key)
      serverTranslationCache.set(key, value)
      persistentTranslationCache.delete(key)
      persistentTranslationCache.set(key, value)
      cacheValue(value, key)
    }
  }
  trimPendingTranslationCache()
}

function rememberTranslation(countryCode: string | null | undefined, city: string, value: string, persist = true, scopeGeneration = translationCacheScopeGeneration): void {
  if (scopeGeneration !== translationCacheScopeGeneration)
    return

  const key = normalizeCityTranslationKey(countryCode, city)
  const serverValue = serverTranslationCache.get(key)
  persistentTranslationCache.delete(key)
  persistentTranslationCache.set(key, value)
  cacheValue(value, key)
  if (persist && serverValue !== value)
    pendingTranslationCache.set(key, value)
  else
    pendingTranslationCache.delete(key)
  trimCache(persistentTranslationCache)
  trimPendingTranslationCache()
}

function getCachedTranslation(countryCode: string | null | undefined, city: string): string | null {
  const key = normalizeCityTranslationKey(countryCode, city)
  const persistent = persistentTranslationCache.get(key)
  if (persistent)
    return persistent

  const cached = translationCache.get(key)
  if (!cached)
    return null
  if (cached.expiresAt <= Date.now()) {
    translationCache.delete(key)
    return null
  }
  return cached.value
}

function isUsableTranslation(value: string | null, source: string): value is string {
  if (!value)
    return false

  const translated = value.trim()
  if (!translated || translated.toLocaleLowerCase() === source.toLocaleLowerCase())
    return false

  return isChineseText(translated)
}

async function fetchJson(url: string): Promise<unknown> {
  if (typeof fetch !== 'function')
    return null

  const controller = new AbortController()
  const timeoutId = globalThis.setTimeout(() => controller.abort(), CITY_TRANSLATION_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok)
      return null
    return await response.json()
  }
  catch {
    return null
  }
  finally {
    globalThis.clearTimeout(timeoutId)
  }
}

function parseGoogleTranslation(payload: unknown): string | null {
  if (!Array.isArray(payload) || !Array.isArray(payload[0]))
    return null

  const text = payload[0]
    .map(part => Array.isArray(part) && typeof part[0] === 'string' ? part[0] : '')
    .join('')
    .trim()
  return text || null
}

function parseMyMemoryTranslation(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object')
    return null
  const responseData = (payload as Record<string, unknown>).responseData
  if (!responseData || typeof responseData !== 'object')
    return null
  const translatedText = (responseData as Record<string, unknown>).translatedText
  return typeof translatedText === 'string' ? translatedText.trim() || null : null
}

async function requestAutomaticTranslation(city: string): Promise<string | null> {
  const encodedCity = encodeURIComponent(city)
  const translated = parseGoogleTranslation(await fetchJson(
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodedCity}`,
  ))
  if (isUsableTranslation(translated, city))
    return translated

  const fallback = parseMyMemoryTranslation(await fetchJson(
    `https://api.mymemory.translated.net/get?q=${encodedCity}&langpair=en%7Czh-CN`,
  ))
  return isUsableTranslation(fallback, city) ? fallback : null
}

/** Return an already-localized city synchronously when the geocoder supplied Chinese text. */
export function formatCityNameZh(city: string | null | undefined): string {
  const trimmed = city?.trim() ?? ''
  return trimmed && isChineseText(trimmed) ? trimmed : ''
}

/** Translate a city and use the server-hydrated cache before making a network request. */
export async function translateCityNameZh(city: string | null | undefined, countryCode?: string | null): Promise<string | null> {
  const trimmed = city?.trim() ?? ''
  if (!trimmed)
    return null
  if (shouldPreserveOriginalCityName(trimmed))
    return trimmed
  if (isChineseText(trimmed)) {
    rememberTranslation(countryCode, trimmed, trimmed)
    return trimmed
  }

  const key = normalizeCityTranslationKey(countryCode, trimmed)
  const scopeGeneration = translationCacheScopeGeneration
  const inflightKey = `${scopeGeneration}\u0000${key}`
  const cached = getCachedTranslation(countryCode, trimmed)
  if (cached)
    return cached

  const existing = translationInflight.get(inflightKey)
  if (existing)
    return existing

  const task = requestAutomaticTranslation(trimmed)
    .then((translated) => {
      if (translated)
        rememberTranslation(countryCode, trimmed, translated, true, scopeGeneration)
      else
        rememberFailedTranslation(key, scopeGeneration)
      return translated
    })
    .catch(() => {
      rememberFailedTranslation(key, scopeGeneration)
      return null
    })
    .finally(() => {
      translationInflight.delete(inflightKey)
    })

  translationInflight.set(inflightKey, task)
  return task
}
