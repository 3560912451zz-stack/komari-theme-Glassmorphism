import type { PublicSettings } from '@/utils/api'
import { getAuthSession } from '@/services/auth.service'
import { getSharedApi } from '@/utils/api'
import {
  acknowledgeCityTranslationEntries,
  getPendingCityTranslationEntries,
  hydrateCityTranslationCache,
  mergeCityTranslationCache,
  parseCityTranslationCache,
  serializeCityTranslationCache,
  translateCityNameZh,
} from '@/utils/cityNameHelper'

const DEFAULT_THEME_SHORT = 'Glassmorphism'
const CITY_TRANSLATION_FLUSH_DELAY_MS = 1400
const CITY_TRANSLATION_FLUSH_RETRIES = 2
const CITY_TRANSLATION_LOCK_NAME = 'glassmorphism-city-translation-cache'
const CITY_TRANSLATION_LOCK_STORAGE_KEY = `__${CITY_TRANSLATION_LOCK_NAME}:lease`
const CITY_TRANSLATION_LOCK_LEASE_MS = 45_000
const CITY_TRANSLATION_LOCK_SETTLE_MS = 40
const CITY_TRANSLATION_LOCK_RETRY_MS = 90

type LockAssertion = () => void
type LockTask<T> = (assertLock: LockAssertion) => Promise<T>

interface StorageLease {
  owner: string
  expiresAt: number
}

let configuredThemeShort = DEFAULT_THEME_SHORT
let configuredCacheScope = ''
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushPromise: Promise<void> | null = null
let flushAgain = false
let inMemoryLockTail: Promise<void> = Promise.resolve()

function normalizeThemeSettings(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return normalizeThemeSettings(JSON.parse(raw) as unknown)
    }
    catch {
      return {}
    }
  }

  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {}
}

export function initializeCityTranslationService(settings?: Pick<PublicSettings, 'theme' | 'theme_settings'> | null): void {
  const theme = settings?.theme?.trim()
  if (theme) {
    configuredThemeShort = theme
    const origin = typeof location === 'undefined' ? '' : location.origin
    configuredCacheScope = `${origin}|${theme}`
  }
  hydrateCityTranslationCache(normalizeThemeSettings(settings?.theme_settings).cityTranslationCache, configuredCacheScope)
}

function scheduleFlush(): void {
  if (!getAuthSession().authenticated)
    return

  if (flushTimer)
    clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushPendingCityTranslations()
  }, CITY_TRANSLATION_FLUSH_DELAY_MS)
}

function getLocalStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
  }
  catch {
    return null
  }
}

function readStorageLease(storage: Storage): StorageLease | null {
  try {
    const raw = storage.getItem(CITY_TRANSLATION_LOCK_STORAGE_KEY)
    if (!raw)
      return null
    const parsed = JSON.parse(raw) as Partial<StorageLease>
    return typeof parsed.owner === 'string' && typeof parsed.expiresAt === 'number'
      ? parsed as StorageLease
      : null
  }
  catch {
    return null
  }
}

function writeStorageLease(storage: Storage, lease: StorageLease): boolean {
  try {
    storage.setItem(CITY_TRANSLATION_LOCK_STORAGE_KEY, JSON.stringify(lease))
    return true
  }
  catch {
    return false
  }
}

function releaseStorageLease(storage: Storage, owner: string): void {
  try {
    if (readStorageLease(storage)?.owner === owner)
      storage.removeItem(CITY_TRANSLATION_LOCK_STORAGE_KEY)
  }
  catch {
    // Storage can become unavailable while a tab is closing.
  }
}

function createLockOwner(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function waitForLock(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function withInMemoryWriteLock<T>(callback: LockTask<T>): Promise<T> {
  let release!: () => void
  const turn = inMemoryLockTail
  inMemoryLockTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await turn
  try {
    return await callback(() => {})
  }
  finally {
    release()
  }
}

/**
 * Fallback for browsers without Web Locks. The lease is deliberately short,
 * renewed while the request is running, and every critical boundary checks
 * ownership. Read-back verification still protects the server-side merge if a
 * background tab is suspended long enough to lose its lease.
 */
async function withStorageWriteLock<T>(callback: LockTask<T>): Promise<T> {
  const storage = getLocalStorage()
  if (!storage)
    return withInMemoryWriteLock(callback)

  const owner = createLockOwner()
  for (;;) {
    const current = readStorageLease(storage)
    if (!current || current.expiresAt <= Date.now()) {
      const lease: StorageLease = { owner, expiresAt: Date.now() + CITY_TRANSLATION_LOCK_LEASE_MS }
      if (!writeStorageLease(storage, lease))
        return withInMemoryWriteLock(callback)

      // Give simultaneous contenders one turn to publish their lease before
      // accepting ownership. The loser observes a different owner and retries.
      await waitForLock(CITY_TRANSLATION_LOCK_SETTLE_MS)
      if (readStorageLease(storage)?.owner !== owner)
        continue

      let leaseLost = false
      const renewLease = () => {
        const latest = readStorageLease(storage)
        if (!latest || latest.owner !== owner) {
          leaseLost = true
          return
        }
        leaseLost = !writeStorageLease(storage, {
          owner,
          expiresAt: Date.now() + CITY_TRANSLATION_LOCK_LEASE_MS,
        })
      }
      const heartbeat = setInterval(renewLease, Math.floor(CITY_TRANSLATION_LOCK_LEASE_MS / 3))
      const assertLock: LockAssertion = () => {
        const latest = readStorageLease(storage)
        if (leaseLost || !latest || latest.owner !== owner || latest.expiresAt <= Date.now()) {
          leaseLost = true
          throw new Error('City translation cache lock was lost')
        }
      }

      try {
        assertLock()
        return await callback(assertLock)
      }
      finally {
        clearInterval(heartbeat)
        releaseStorageLease(storage, owner)
      }
    }

    await waitForLock(CITY_TRANSLATION_LOCK_RETRY_MS + Math.floor(Math.random() * CITY_TRANSLATION_LOCK_RETRY_MS))
  }
}

async function withCrossTabWriteLock<T>(callback: LockTask<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    let callbackStarted = false
    try {
      return await navigator.locks.request(CITY_TRANSLATION_LOCK_NAME, { mode: 'exclusive' }, () => {
        callbackStarted = true
        return callback(() => {})
      })
    }
    catch (error) {
      // A browser may expose Web Locks but reject it in an insecure or
      // partitioned context. Only fall back when the callback never started;
      // callback errors must not execute the write twice.
      if (!callbackStarted)
        return withStorageWriteLock(callback)
      throw error
    }
  }

  return withStorageWriteLock(callback)
}

async function writePendingCityTranslations(assertLock: LockAssertion): Promise<void> {
  assertLock()
  if (!getAuthSession().authenticated)
    return

  const pendingAtStart = getPendingCityTranslationEntries()
  if (pendingAtStart.size === 0)
    return
  const scopeAtStart = configuredCacheScope

  const api = getSharedApi()
  let lastError: unknown

  for (let attempt = 0; attempt <= CITY_TRANSLATION_FLUSH_RETRIES; attempt += 1) {
    try {
      assertLock()
      if (scopeAtStart !== configuredCacheScope)
        return
      // The endpoint replaces the complete theme settings object. Always merge with
      // a fresh snapshot so an admin save made in another tab is not discarded.
      const latest = await api.getPublicSettings()
      assertLock()
      if (scopeAtStart !== configuredCacheScope)
        return
      const latestSettings = normalizeThemeSettings(latest.theme_settings)
      const mergedCache = mergeCityTranslationCache(latestSettings.cityTranslationCache, pendingAtStart)

      const themeShort = latest.theme?.trim() || configuredThemeShort
      assertLock()
      await api.updateThemeSettings(themeShort, {
        ...latestSettings,
        cityTranslationCache: serializeCityTranslationCache(mergedCache),
      })

      // Komari 1.3.x can report success even when the database write failed.
      assertLock()
      const verified = await api.getPublicSettings()
      assertLock()
      const verifiedEntries = parseCityTranslationCache(normalizeThemeSettings(verified.theme_settings).cityTranslationCache)
      const confirmed = new Map<string, string>()
      for (const [key, value] of pendingAtStart) {
        if (verifiedEntries.get(key) === value)
          confirmed.set(key, value)
      }

      if (confirmed.size === pendingAtStart.size) {
        assertLock()
        acknowledgeCityTranslationEntries(confirmed)
        return
      }

      throw new Error('Server did not confirm the city translation cache write')
    }
    catch (error) {
      lastError = error
      if (attempt < CITY_TRANSLATION_FLUSH_RETRIES)
        await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
    }
  }

  console.warn('[CityTranslation] Failed to persist city translations', lastError)
}

/** Flush queued translations serially; callers may safely invoke this repeatedly. */
export async function flushPendingCityTranslations(): Promise<void> {
  if (!getAuthSession().authenticated)
    return

  if (flushPromise) {
    flushAgain = true
    return flushPromise
  }

  // Theme settings are replaced as a whole. Serialize writes across same-origin
  // administrator tabs so each writer reads the result of the previous one.
  flushPromise = withCrossTabWriteLock(writePendingCityTranslations)
    .finally(() => {
      flushPromise = null
      if (flushAgain) {
        flushAgain = false
        scheduleFlush()
      }
    })

  return flushPromise
}

/** Resolve a city from server memory and queue only newly discovered translations for admins. */
export async function translateCityNameWithServerCache(city: string | null | undefined, countryCode?: string | null): Promise<string | null> {
  const translated = await translateCityNameZh(city, countryCode)
  if (translated && getAuthSession().authenticated && getPendingCityTranslationEntries().size > 0)
    scheduleFlush()
  return translated
}
