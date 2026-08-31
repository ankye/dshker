import { DEFAULT_SETTINGS, type AppSettings } from './contracts'
import { getDesktopApi } from './bridge'
import { unwrapResult } from './errors'

const THEME_VALUES = new Set(['system', 'light', 'dark'])
const LOCALE_PATTERN = /^[a-z]{2}(?:-[A-Z]{2})?$/

export function normalizeSettings(input: Partial<AppSettings> | undefined): AppSettings {
  const next = { ...DEFAULT_SETTINGS, ...(input || {}) }

  return {
    theme: THEME_VALUES.has(next.theme) ? next.theme : DEFAULT_SETTINGS.theme,
    locale: LOCALE_PATTERN.test(next.locale) ? next.locale : DEFAULT_SETTINGS.locale,
    accentColor: /^#[0-9a-fA-F]{6}$/.test(next.accentColor)
      ? next.accentColor
      : DEFAULT_SETTINGS.accentColor,
    telemetryEnabled: Boolean(next.telemetryEnabled),
    autoUpdateChecks: Boolean(next.autoUpdateChecks)
  }
}

export async function loadSettings(api = getDesktopApi()): Promise<AppSettings> {
  if (!api?.settings) return DEFAULT_SETTINGS
  return normalizeSettings(unwrapResult(await api.settings.load()))
}

export async function saveSettings(
  settings: AppSettings,
  api = getDesktopApi()
): Promise<AppSettings> {
  if (!api?.settings) return normalizeSettings(settings)
  return normalizeSettings(unwrapResult(await api.settings.save(normalizeSettings(settings))))
}

export async function resetSettings(api = getDesktopApi()): Promise<AppSettings> {
  if (!api?.settings) return DEFAULT_SETTINGS
  return normalizeSettings(unwrapResult(await api.settings.reset()))
}
