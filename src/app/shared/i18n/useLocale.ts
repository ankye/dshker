import { computed, ref } from 'vue'
import {
  INITIAL_LOCALE,
  SUPPORTED_LOCALES,
  createTranslator,
  type MessageKey,
  type SupportedLocale
} from './i18n'

/** Storage key holding the display language across Launcher restarts. */
const LOCALE_STORAGE_KEY = 'dsh-launcher.locale'

/** Narrows an arbitrary stored string to a supported locale. */
function parseLocale(value: string | null): SupportedLocale | undefined {
  return SUPPORTED_LOCALES.find((entry) => entry.locale === value)?.locale
}

/** Reads the persisted locale; unavailable or unusable storage keeps the default. */
function loadLocale(): SupportedLocale {
  try {
    return parseLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY)) ?? INITIAL_LOCALE
  } catch {
    return INITIAL_LOCALE
  }
}

// Module-level state: every surface renders one interface language, so the
// selection made in Settings must drive all of them at once.
const activeLocale = ref<SupportedLocale>(loadLocale())

/** The locale every translator currently resolves against. */
export const locale = computed(() => activeLocale.value)

/**
 * Publishes the active locale to the document.
 *
 * Called once from the shell. `index.html` ships a static `lang`, so without
 * this the document advertised the wrong language to assistive technology until
 * the user happened to change the setting.
 */
export function startLocale(): void {
  document.documentElement.lang = activeLocale.value
}

/**
 * Switches the interface language and persists the choice.
 *
 * Failing storage is ignored on purpose: the language must still change for the
 * current session even when persistence is unavailable.
 */
export function setLocale(next: SupportedLocale): void {
  if (parseLocale(next) === undefined) return
  activeLocale.value = next
  document.documentElement.lang = next
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, next)
  } catch {
    // Persistence is best-effort.
  }
}

/**
 * Returns a stable translator function that follows the active locale.
 *
 * The identity of the returned function never changes, but it reads the
 * reactive locale on every call. Components therefore keep calling `t(key)`
 * unchanged, and both templates and `computed` values that use it re-evaluate
 * when the language switches.
 */
export function useTranslator(): (key: MessageKey) => string {
  return (key) => catalogFor(activeLocale.value)(key)
}

/** Caches one translator per locale so each call does not rebuild the closure. */
const translators = new Map<SupportedLocale, (key: MessageKey) => string>()

function catalogFor(value: SupportedLocale): (key: MessageKey) => string {
  const existing = translators.get(value)
  if (existing) return existing
  const created = createTranslator(value)
  translators.set(value, created)
  return created
}
