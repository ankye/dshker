/**
 * Application-wide theme state.
 *
 * This lives outside the settings route on purpose. While it was owned by
 * `SettingsPanel`, the persisted choice was only applied when that route
 * happened to be mounted, so a saved light theme did not survive a restart
 * until the user visited Settings. Selecting `system` also resolved the OS
 * preference exactly once, leaving the window stale when the OS switched
 * appearance while the app was open.
 * @module
 */

import { computed, ref } from 'vue'

export type Theme = 'system' | 'dark' | 'light'

/** Concrete appearance the stylesheet defines; `system` resolves to one of these. */
export type ResolvedTheme = 'dark' | 'light'

/** Storage key holding the theme across Launcher restarts. */
const THEME_STORAGE_KEY = 'dsh-launcher.theme'

const LIGHT_PREFERENCE_QUERY = '(prefers-color-scheme: light)'

const selected = ref<Theme>(loadTheme())
const systemPrefersLight = ref(matchesLightPreference())

/** The appearance actually applied to the document. */
const resolved = computed<ResolvedTheme>(() =>
  selected.value === 'system' ? (systemPrefersLight.value ? 'light' : 'dark') : selected.value
)

let started = false

/** Reads the persisted theme; unavailable or unusable storage keeps the default. */
function loadTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'system' || stored === 'dark' || stored === 'light') return stored
  } catch {
    // Fall through to the default.
  }
  return 'dark'
}

function lightPreferenceQuery(): MediaQueryList | undefined {
  // Guarded because a non-browser test environment may not implement it.
  return typeof window.matchMedia === 'function'
    ? window.matchMedia(LIGHT_PREFERENCE_QUERY)
    : undefined
}

function matchesLightPreference(): boolean {
  return lightPreferenceQuery()?.matches ?? false
}

/**
 * Applies the resolved appearance and begins tracking the OS preference.
 *
 * Called once from the shell so the persisted theme is in effect on the first
 * frame of every route, not only after Settings is opened.
 */
export function startTheme(): void {
  applyResolvedTheme()
  if (started) return
  started = true

  const query = lightPreferenceQuery()
  if (query === undefined) return
  // Keeps `system` honest while the app stays open.
  query.addEventListener('change', (event) => {
    systemPrefersLight.value = event.matches
    applyResolvedTheme()
  })
}

function applyResolvedTheme(): void {
  document.documentElement.dataset.theme = resolved.value
}

/** Records the choice, applies it immediately, and persists it best-effort. */
export function setTheme(value: Theme): void {
  selected.value = value
  applyResolvedTheme()
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, value)
  } catch {
    // Persistence is best-effort; the session still honours the choice.
  }
}

export const theme = {
  /** The user's selection, including `system`. */
  selected: computed(() => selected.value),
  /** The appearance in effect right now. */
  resolved
}
