import { randomUUID } from 'node:crypto'
import { chmod, lstat, open, readFile, rename, rm } from 'node:fs/promises'
import nodePath from 'node:path'
import {
  RUNTIME_BROWSER_DEFAULT_ZOOM_PERCENT,
  RUNTIME_BROWSER_ZOOM_PERCENTAGES,
  type RuntimeBrowserPreferences,
  type RuntimeBrowserZoomPercent
} from '../../src/shared/contracts'
import { ManagedRootError } from './managed/errors'
import { pathApiFor, type ManagedPathStyle } from './managed/validation'

/** Persisted identity for Launcher-owned embedded-browser preferences. */
export const RUNTIME_BROWSER_PREFERENCES_FORMAT =
  'dsh-launcher.runtime-browser-preferences' as const

/** First strict embedded-browser preference revision. */
export const RUNTIME_BROWSER_PREFERENCES_VERSION = 1 as const

/** Exact versioned document written below the registered Settings root. */
export interface RuntimeBrowserPreferencesRecord extends RuntimeBrowserPreferences {
  readonly format: typeof RUNTIME_BROWSER_PREFERENCES_FORMAT
  readonly version: typeof RUNTIME_BROWSER_PREFERENCES_VERSION
}

/** Resolves the current registered Settings root for every public store operation. */
export interface RuntimeBrowserPreferencesStoreOptions {
  readonly resolveSettingsRoot: () => Promise<string>
}

/** Strict parser and atomic persistence for Launcher-owned runtime-browser preferences. */
export class RuntimeBrowserPreferencesStore {
  readonly #resolveSettingsRoot: () => Promise<string>

  constructor(options: RuntimeBrowserPreferencesStoreOptions) {
    this.#resolveSettingsRoot = options.resolveSettingsRoot
  }

  /** Reads the exact persisted record or explicitly creates the first 100 percent record. */
  async load(): Promise<RuntimeBrowserPreferences> {
    const filePath = await this.#resolveFilePath()
    return projectPreferences(await loadOrCreateRecord(filePath))
  }

  /** Validates existing state before atomically persisting one admitted page-zoom selection. */
  async setZoom(zoomPercent: RuntimeBrowserZoomPercent): Promise<RuntimeBrowserPreferences> {
    const filePath = await this.#resolveFilePath()
    await loadOrCreateRecord(filePath)
    if (!isRuntimeBrowserZoomPercent(zoomPercent)) {
      throw new ManagedRootError(
        'managed.invalid_record',
        'Runtime browser zoom percentage is invalid.'
      )
    }
    const next = createRuntimeBrowserPreferencesRecord(zoomPercent)
    await saveRecord(filePath, next)
    return projectPreferences(next)
  }

  async #resolveFilePath(): Promise<string> {
    const settingsRoot = await this.#resolveSettingsRoot()
    return runtimeBrowserPreferencesFilePath(settingsRoot, currentPathStyle())
  }
}

/** Derives the only preference-file location below the registered Settings root. */
export function runtimeBrowserPreferencesFilePath(
  settingsRoot: string,
  style: ManagedPathStyle
): string {
  const pathApi = pathApiFor(style)
  const launcherDirectory = pathApi.join(settingsRoot, 'dsh-launcher')
  const filePath = pathApi.join(launcherDirectory, 'runtime-browser-preferences.json')
  if (
    !isStrictChild(settingsRoot, launcherDirectory, style) ||
    !isStrictChild(launcherDirectory, filePath, style)
  ) {
    throw new ManagedRootError(
      'managed.persistence_failed',
      'Runtime browser preference path escapes the registered Settings root.'
    )
  }
  return filePath
}

/** Parses every persisted field and refuses malformed, unknown, or future records. */
export function parseRuntimeBrowserPreferences(text: string): RuntimeBrowserPreferencesRecord {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw persistenceError('Runtime browser preferences are not valid JSON.', error)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Runtime browser preferences must be an object.'
    )
  }
  const record = value as Record<string, unknown>
  const expected = ['format', 'version', 'zoomPercent']
  const actual = Object.keys(record)
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Runtime browser preference fields are invalid.'
    )
  }
  if (record.format !== RUNTIME_BROWSER_PREFERENCES_FORMAT) {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Runtime browser preference format is invalid.'
    )
  }
  if (record.version !== RUNTIME_BROWSER_PREFERENCES_VERSION) {
    throw new ManagedRootError(
      'managed.unsupported_version',
      'Runtime browser preference version is unsupported.'
    )
  }
  if (!isRuntimeBrowserZoomPercent(record.zoomPercent)) {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Runtime browser zoom percentage is invalid.'
    )
  }
  return {
    format: RUNTIME_BROWSER_PREFERENCES_FORMAT,
    version: RUNTIME_BROWSER_PREFERENCES_VERSION,
    zoomPercent: record.zoomPercent
  }
}

async function loadOrCreateRecord(filePath: string): Promise<RuntimeBrowserPreferencesRecord> {
  const parent = nodePath.dirname(filePath)
  await assertPreferencesDirectory(parent)
  await assertNotSymlink(filePath)

  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if (!isNodeCode(error, 'ENOENT')) {
      throw persistenceError('Unable to read runtime browser preferences.', error)
    }
    const defaults = createRuntimeBrowserPreferencesRecord(RUNTIME_BROWSER_DEFAULT_ZOOM_PERCENT)
    await saveRecord(filePath, defaults)
    return defaults
  }
  return parseRuntimeBrowserPreferences(text)
}

async function saveRecord(
  filePath: string,
  preferences: RuntimeBrowserPreferencesRecord
): Promise<void> {
  validateRuntimeBrowserPreferencesRecord(preferences)
  const parent = nodePath.dirname(filePath)
  await assertPreferencesDirectory(parent)
  await assertNotSymlink(filePath)
  const temporaryPath = nodePath.join(parent, `.${nodePath.basename(filePath)}.${randomUUID()}.tmp`)
  const serialized = `${JSON.stringify(preferences, null, 2)}\n`

  try {
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(serialized, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, filePath)
    await chmod(filePath, 0o600)
    await syncParentDirectory(parent)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw persistenceError('Unable to persist runtime browser preferences.', error)
  }

  let reloaded: RuntimeBrowserPreferencesRecord
  try {
    reloaded = parseRuntimeBrowserPreferences(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error instanceof ManagedRootError) throw error
    throw persistenceError('Unable to read back runtime browser preferences.', error)
  }
  if (JSON.stringify(reloaded) !== JSON.stringify(preferences)) {
    throw new ManagedRootError(
      'managed.persistence_failed',
      'Runtime browser preference readback differs from the committed record.'
    )
  }
}

function createRuntimeBrowserPreferencesRecord(
  zoomPercent: RuntimeBrowserZoomPercent
): RuntimeBrowserPreferencesRecord {
  return {
    format: RUNTIME_BROWSER_PREFERENCES_FORMAT,
    version: RUNTIME_BROWSER_PREFERENCES_VERSION,
    zoomPercent
  }
}

function validateRuntimeBrowserPreferencesRecord(
  preferences: RuntimeBrowserPreferencesRecord
): void {
  if (preferences.format !== RUNTIME_BROWSER_PREFERENCES_FORMAT) {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Runtime browser preference format is invalid.'
    )
  }
  if (preferences.version !== RUNTIME_BROWSER_PREFERENCES_VERSION) {
    throw new ManagedRootError(
      'managed.unsupported_version',
      'Runtime browser preference version is unsupported.'
    )
  }
  if (!isRuntimeBrowserZoomPercent(preferences.zoomPercent)) {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Runtime browser zoom percentage is invalid.'
    )
  }
}

function projectPreferences(record: RuntimeBrowserPreferencesRecord): RuntimeBrowserPreferences {
  return { zoomPercent: record.zoomPercent }
}

function isRuntimeBrowserZoomPercent(value: unknown): value is RuntimeBrowserZoomPercent {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    RUNTIME_BROWSER_ZOOM_PERCENTAGES.includes(value as RuntimeBrowserZoomPercent)
  )
}

async function assertPreferencesDirectory(directoryPath: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>
  try {
    stats = await lstat(directoryPath)
  } catch (error) {
    throw persistenceError('Launcher preference directory is unavailable.', error)
  }
  if (stats.isSymbolicLink()) {
    throw new ManagedRootError(
      'managed.root_symbolic_link',
      'Launcher preference directory must not be a symbolic link.'
    )
  }
  if (!stats.isDirectory()) {
    throw new ManagedRootError(
      'managed.persistence_failed',
      'Launcher preference location is not a directory.'
    )
  }
}

async function assertNotSymlink(filePath: string): Promise<void> {
  try {
    if ((await lstat(filePath)).isSymbolicLink()) {
      throw new ManagedRootError(
        'managed.persistence_failed',
        'Runtime browser preference path must not be a symbolic link.'
      )
    }
  } catch (error) {
    if (isNodeCode(error, 'ENOENT')) return
    if (error instanceof ManagedRootError) throw error
    throw persistenceError('Unable to inspect the runtime browser preference path.', error)
  }
}

async function syncParentDirectory(parent: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(parent, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function isStrictChild(parent: string, child: string, style: ManagedPathStyle): boolean {
  const pathApi = pathApiFor(style)
  const relative = pathApi.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !pathApi.isAbsolute(relative)
}

function currentPathStyle(): ManagedPathStyle {
  return process.platform === 'win32' ? 'win32' : 'posix'
}

function persistenceError(message: string, cause: unknown): ManagedRootError {
  return new ManagedRootError('managed.persistence_failed', message, {
    cause: cause instanceof Error ? cause.name : 'unknown'
  })
}

function isNodeCode(value: unknown, expected: string): boolean {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === expected)
}
