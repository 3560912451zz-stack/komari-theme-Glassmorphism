/**
 * City localization is resolved at runtime. The page keeps a small in-memory
 * cache for the current session, but never writes city translations to disk.
 */

const CJK_UNIFIED_IDEOGRAPH_REGEX = /\p{Script=Han}/u
const CITY_WHITESPACE_REGEX = /\s+/g
const CITY_TRANSLATION_TIMEOUT_MS = 1800
const CITY_TRANSLATION_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CITY_TRANSLATION_FAILURE_TTL_MS = 5 * 60 * 1000
const CITY_TRANSLATION_CACHE_MAX_SIZE = 512

interface TranslationCacheEntry {
  value: string | null
  expiresAt: number
}

const translationCache = new Map<string, TranslationCacheEntry>()
const translationInflight = new Map<string, Promise<string | null>>()

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

function rememberTranslation(key: string, value: string | null): void {
  translationCache.delete(key)
  translationCache.set(key, {
    value,
    expiresAt: Date.now() + (value ? CITY_TRANSLATION_CACHE_TTL_MS : CITY_TRANSLATION_FAILURE_TTL_MS),
  })

  while (translationCache.size > CITY_TRANSLATION_CACHE_MAX_SIZE)
    translationCache.delete(translationCache.keys().next().value as string)
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

  // MyMemory is a secondary endpoint for browsers that block Google's host.
  const fallback = parseMyMemoryTranslation(await fetchJson(
    `https://api.mymemory.translated.net/get?q=${encodedCity}&langpair=en%7Czh-CN`,
  ))
  return isUsableTranslation(fallback, city) ? fallback : null
}

/**
 * Return an already-localized city name synchronously when the geocoder has
 * supplied Chinese text. English input intentionally returns an empty string;
 * callers can then fall back to the original name while async localization is
 * in progress.
 */
export function formatCityNameZh(city: string | null | undefined): string {
  const trimmed = city?.trim() ?? ''
  return trimmed && isChineseText(trimmed) ? trimmed : ''
}

/**
 * Translate an arbitrary city name without a hand-maintained city dictionary.
 * Results are scoped to this page session and requests for the same city are
 * deduplicated across the list, detail view, and earth markers.
 */
export async function translateCityNameZh(city: string | null | undefined): Promise<string | null> {
  const trimmed = city?.trim() ?? ''
  if (!trimmed)
    return null
  if (isChineseText(trimmed))
    return trimmed

  const key = normalizeTranslationKey(trimmed)
  const cached = translationCache.get(key)
  if (cached && cached.expiresAt > Date.now())
    return cached.value
  if (cached)
    translationCache.delete(key)

  const existing = translationInflight.get(key)
  if (existing)
    return existing

  const task = requestAutomaticTranslation(trimmed)
    .then((translated) => {
      rememberTranslation(key, translated)
      return translated
    })
    .catch(() => {
      rememberTranslation(key, null)
      return null
    })
    .finally(() => {
      translationInflight.delete(key)
    })

  translationInflight.set(key, task)
  return task
}
