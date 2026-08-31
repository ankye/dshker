import { describe, expect, it } from 'vitest'
import { INITIAL_LOCALE, createTranslator } from './i18n'

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
