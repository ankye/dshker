import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { INITIAL_LOCALE, SUPPORTED_LOCALES, createTranslator } from './i18n'

describe('launcher locales', () => {
  it('has a complete Chinese bootstrap catalog', () => {
    const t = createTranslator(INITIAL_LOCALE)

    expect(t('app.title')).toBe('DSH Launcher')
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
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'i18n.ts'),
    'utf8'
  )
  const catalogs = source.slice(source.indexOf('const zhCN = {'))
  const boundary = catalogs.indexOf('const enUS')

  /** Message keys and values of one catalog literal, in source order. */
  function entries(block: string): ReadonlyMap<string, string> {
    const found = new Map<string, string>()
    for (const match of block.matchAll(/^ {2}'([^']+)':\s*\n?\s*'((?:[^'\\]|\\.)*)'/gmu)) {
      found.set(match[1], match[2])
    }
    return found
  }

  const zh = entries(catalogs.slice(0, boundary))
  const en = entries(catalogs.slice(boundary))

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
