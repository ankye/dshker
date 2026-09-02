import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Theme persistence and OS tracking.
 *
 * Two defects this pins, both from the theme being owned by the settings route:
 * a saved light theme was only applied once Settings had been opened, so it
 * appeared not to survive a restart; and a `system` selection read the OS
 * preference exactly once, so the window stayed stale when the OS switched
 * appearance while the app was open.
 */
type MediaListener = (event: { matches: boolean }) => void

interface MediaQueryStub {
  matches: boolean
  readonly listeners: MediaListener[]
  emit(matches: boolean): void
}

function stubEnvironment(options: {
  readonly stored?: string
  readonly prefersLight?: boolean
}): MediaQueryStub {
  const store = new Map<string, string>()
  if (options.stored !== undefined) store.set('dsh-launcher.theme', options.stored)

  const query: MediaQueryStub = {
    matches: options.prefersLight ?? false,
    listeners: [],
    emit(matches: boolean) {
      query.matches = matches
      for (const listener of query.listeners) listener({ matches })
    }
  }

  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value)
    },
    matchMedia: (input: string) => {
      expect(input).toBe('(prefers-color-scheme: light)')
      return {
        matches: query.matches,
        addEventListener: (_event: string, listener: MediaListener) => {
          query.listeners.push(listener)
        }
      }
    }
  })

  return query
}

/** Fresh module per case, because the store is module-level singleton state. */
async function loadThemeModule() {
  vi.resetModules()
  return await import('../theme/useTheme')
}

describe('application theme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.unstubAllGlobals()
  })

  it('applies a persisted theme before any route mounts', async () => {
    stubEnvironment({ stored: 'light' })
    const { startTheme } = await loadThemeModule()

    startTheme()

    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('defaults to dark when nothing is persisted', async () => {
    stubEnvironment({})
    const { startTheme, theme } = await loadThemeModule()

    startTheme()

    expect(theme.selected.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('resolves a system selection against the OS preference', async () => {
    stubEnvironment({ stored: 'system', prefersLight: true })
    const { startTheme, theme } = await loadThemeModule()

    startTheme()

    expect(theme.selected.value).toBe('system')
    expect(theme.resolved.value).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('follows a live OS appearance change while set to system', async () => {
    const query = stubEnvironment({ stored: 'system', prefersLight: false })
    const { startTheme, theme } = await loadThemeModule()
    startTheme()
    expect(document.documentElement.dataset.theme).toBe('dark')

    query.emit(true)

    expect(theme.resolved.value).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('ignores the OS preference once an explicit theme is chosen', async () => {
    const query = stubEnvironment({ stored: 'system', prefersLight: true })
    const { setTheme, startTheme, theme } = await loadThemeModule()
    startTheme()

    setTheme('dark')
    query.emit(true)

    expect(theme.resolved.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('persists an explicit choice so the next launch honours it', async () => {
    stubEnvironment({})
    const { setTheme } = await loadThemeModule()

    setTheme('light')

    expect(window.localStorage.getItem('dsh-launcher.theme')).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('still applies the choice when persistence is unavailable', async () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('storage denied')
        }
      },
      matchMedia: () => ({ matches: false, addEventListener: () => undefined })
    })
    const { setTheme, theme } = await loadThemeModule()

    expect(() => setTheme('light')).not.toThrow()
    expect(theme.resolved.value).toBe('light')
  })
})
