import { describe, expect, it } from 'vitest'
import { INITIAL_LOCALE, SUPPORTED_LOCALES, createTranslator, enUS, zhCN } from './i18n'

describe('launcher locales', () => {
  it('has a complete Chinese bootstrap catalog', () => {
    const t = createTranslator(INITIAL_LOCALE)

    expect(t('app.title')).toBe('DSHKer Launcher')
    expect(t('bootstrap.title')).toContain('目录')
  })

  it('selects an explicitly supported English catalog', () => {
    const t = createTranslator('en-US')

    expect(t('workspace.blocked')).toContain('does not create')
  })
})

/**
 * Catalog parity and translation completeness.
 *
 * The type system requires every key to exist in both catalogs, but it cannot
 * see an entry that was copied across untranslated, which silently ships English
 * text to a Chinese user or the reverse.
 */
describe('locale catalog parity', () => {
  const zh = new Map(Object.entries(zhCN))
  const en = new Map(Object.entries(enUS))

  it('defines the same message keys in every catalog', () => {
    const localeLabels = new Set<string>(SUPPORTED_LOCALES.map((entry) => entry.locale))
    const englishKeys = [...en.keys()].filter((key) => !localeLabels.has(key))

    expect([...zh.keys()].sort()).toStrictEqual(englishKeys.sort())
  })

  it('translates every message rather than copying one catalog into the other', () => {
    // Proper nouns and command strings are legitimately identical.
    const identicalByDesign = /^[\x20-\x7E]*$/u
    const untranslated = [...zh.entries()]
      .filter(([key, value]) => en.get(key) === value && !identicalByDesign.test(value))
      .map(([key]) => key)

    expect(untranslated).toStrictEqual([])
  })

  it('keeps every message non-empty in both catalogs', () => {
    for (const [key, value] of zh) {
      expect(value.trim(), `zh-CN ${key} must not be empty`).not.toBe('')
      expect(en.get(key)?.trim(), `en-US ${key} must not be empty`).not.toBe('')
    }
  })
})
