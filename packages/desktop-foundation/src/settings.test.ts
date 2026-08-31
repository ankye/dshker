import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './contracts'
import { normalizeSettings } from './settings'

describe('settings foundation', () => {
  it('merges valid settings with defaults', () => {
    expect(
      normalizeSettings({
        theme: 'dark',
        locale: 'zh-CN',
        accentColor: '#123456'
      })
    ).toEqual({
      ...DEFAULT_SETTINGS,
      theme: 'dark',
      locale: 'zh-CN',
      accentColor: '#123456'
    })
  })

  it('rejects invalid theme, locale, and accent values', () => {
    expect(
      normalizeSettings({
        theme: 'invalid' as never,
        locale: 'english',
        accentColor: 'blue',
        telemetryEnabled: true
      })
    ).toEqual({
      ...DEFAULT_SETTINGS,
      telemetryEnabled: true
    })
  })
})
