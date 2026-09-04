import { enUS } from './messages.en-US'
import { zhCN } from './messages.zh-CN'
import type { MessageKey } from './messages.zh-CN'

export { enUS, zhCN }
export type { MessageKey }

export const INITIAL_LOCALE = 'zh-CN' as const

export const SUPPORTED_LOCALES = [
  { locale: 'zh-CN', label: '简体中文' },
  { locale: 'en-US', label: 'English' }
] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]['locale']

const catalogs: Record<SupportedLocale, Record<MessageKey, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS
}

/** Creates a total translator for a selected, validated locale. */
export function createTranslator(locale: SupportedLocale): (key: MessageKey) => string {
  const catalog = catalogs[locale]
  return (key) => catalog[key]
}
