import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_BROWSER_DEFAULT_ZOOM_PERCENT,
  type RuntimeBrowserZoomPercent
} from '../../src/shared/contracts'
import { ManagedRootError } from './managed/errors'
import {
  RUNTIME_BROWSER_PREFERENCES_FORMAT,
  RUNTIME_BROWSER_PREFERENCES_VERSION,
  RuntimeBrowserPreferencesStore,
  parseRuntimeBrowserPreferences,
  runtimeBrowserPreferencesFilePath
} from './runtime-browser-preferences'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

async function fixture(): Promise<{
  readonly filePath: string
  readonly settingsRoot: string
  readonly store: RuntimeBrowserPreferencesStore
}> {
  const base = await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-browser-preferences-'))
  temporaryDirectories.push(base)
  const settingsRoot = nodePath.join(base, 'settings')
  await mkdir(nodePath.join(settingsRoot, 'dsh-launcher'), { recursive: true })
  const pathStyle = process.platform === 'win32' ? ('win32' as const) : ('posix' as const)
  const filePath = runtimeBrowserPreferencesFilePath(settingsRoot, pathStyle)
  const store = new RuntimeBrowserPreferencesStore({
    resolveSettingsRoot: async () => settingsRoot
  })
  return { filePath, settingsRoot, store }
}

describe('runtime browser preferences', () => {
  it('explicitly creates the first 100 percent record with private permissions', async () => {
    const { filePath, store } = await fixture()

    await expect(store.load()).resolves.toEqual({
      zoomPercent: RUNTIME_BROWSER_DEFAULT_ZOOM_PERCENT
    })
    await expect(readFile(filePath, 'utf8').then(JSON.parse)).resolves.toEqual({
      format: RUNTIME_BROWSER_PREFERENCES_FORMAT,
      version: RUNTIME_BROWSER_PREFERENCES_VERSION,
      zoomPercent: RUNTIME_BROWSER_DEFAULT_ZOOM_PERCENT
    })
    if (process.platform !== 'win32') {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    }
  })

  it('atomically persists and reads an allowed zoom percentage', async () => {
    const { filePath, store } = await fixture()
    await store.load()

    await expect(store.setZoom(125)).resolves.toEqual({ zoomPercent: 125 })

    await expect(store.load()).resolves.toEqual({ zoomPercent: 125 })
    await expect(readFile(filePath, 'utf8')).resolves.toContain('"zoomPercent": 125')
  })

  it('resolves the current Settings root for every operation', async () => {
    const first = await fixture()
    const secondBase = await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-browser-preferences-'))
    temporaryDirectories.push(secondBase)
    const secondSettingsRoot = nodePath.join(secondBase, 'settings')
    await mkdir(nodePath.join(secondSettingsRoot, 'dsh-launcher'), { recursive: true })
    let selectedRoot = first.settingsRoot
    const store = new RuntimeBrowserPreferencesStore({
      resolveSettingsRoot: async () => selectedRoot
    })

    await store.setZoom(125)
    selectedRoot = secondSettingsRoot

    await expect(store.load()).resolves.toEqual({ zoomPercent: 100 })
    await expect(
      readFile(
        runtimeBrowserPreferencesFilePath(
          secondSettingsRoot,
          process.platform === 'win32' ? 'win32' : 'posix'
        ),
        'utf8'
      ).then(JSON.parse)
    ).resolves.toMatchObject({ zoomPercent: 100 })
  })

  it('rejects malformed JSON instead of replacing it with defaults', async () => {
    const { filePath, store } = await fixture()
    await writeFile(filePath, '{broken', { mode: 0o600 })

    await expect(store.load()).rejects.toBeInstanceOf(ManagedRootError)
    await expect(readFile(filePath, 'utf8')).resolves.toBe('{broken')
  })

  it.each([
    {
      name: 'unknown field',
      value: {
        format: RUNTIME_BROWSER_PREFERENCES_FORMAT,
        version: RUNTIME_BROWSER_PREFERENCES_VERSION,
        zoomPercent: 100,
        unknown: true
      },
      code: 'managed.invalid_record'
    },
    {
      name: 'wrong format',
      value: {
        format: 'dsh-launcher.other-preferences',
        version: RUNTIME_BROWSER_PREFERENCES_VERSION,
        zoomPercent: 100
      },
      code: 'managed.invalid_record'
    },
    {
      name: 'future version',
      value: {
        format: RUNTIME_BROWSER_PREFERENCES_FORMAT,
        version: RUNTIME_BROWSER_PREFERENCES_VERSION + 1,
        zoomPercent: 100
      },
      code: 'managed.unsupported_version'
    },
    {
      name: 'unlisted zoom percentage',
      value: {
        format: RUNTIME_BROWSER_PREFERENCES_FORMAT,
        version: RUNTIME_BROWSER_PREFERENCES_VERSION,
        zoomPercent: 120
      },
      code: 'managed.invalid_record'
    }
  ])('rejects a persisted record with $name', async ({ value, code }) => {
    const { filePath, store } = await fixture()
    await writeFile(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 })

    await expect(store.load()).rejects.toMatchObject({ code })
  })

  it('rejects non-object and missing-field records', () => {
    expect(() => parseRuntimeBrowserPreferences('[]')).toThrow(ManagedRootError)
    expect(() =>
      parseRuntimeBrowserPreferences(
        JSON.stringify({
          format: RUNTIME_BROWSER_PREFERENCES_FORMAT,
          version: RUNTIME_BROWSER_PREFERENCES_VERSION
        })
      )
    ).toThrow(ManagedRootError)
  })

  it('validates the existing record before accepting a new zoom selection', async () => {
    const { filePath, store } = await fixture()
    await writeFile(filePath, '{broken', { mode: 0o600 })

    await expect(store.setZoom(125)).rejects.toBeInstanceOf(ManagedRootError)
    await expect(readFile(filePath, 'utf8')).resolves.toBe('{broken')
  })

  it('rejects an invalid zoom before persistence', async () => {
    const { filePath, store } = await fixture()
    await store.load()

    await expect(store.setZoom(99 as RuntimeBrowserZoomPercent)).rejects.toMatchObject({
      code: 'managed.invalid_record'
    })
    await expect(readFile(filePath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      zoomPercent: RUNTIME_BROWSER_DEFAULT_ZOOM_PERCENT
    })
  })
})
