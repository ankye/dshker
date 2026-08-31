import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import nodePath from 'node:path'
import { ManagedRootError } from './errors'
import type { ManagedPathStyle } from './validation'
import {
  assertCanonicalRootPath,
  assertOutsideHarnessRuntimeHome,
  assertOutsideNativeDshHome
} from './validation'

const BOOTSTRAP_LOCATOR_FORMAT = 'dsh-launcher.bootstrap-locator' as const
const BOOTSTRAP_LOCATOR_VERSION = 1 as const

/** The sole small platform-owned pointer to the explicitly selected Settings root. */
export interface ManagedBootstrapLocator {
  readonly format: typeof BOOTSTRAP_LOCATOR_FORMAT
  readonly version: typeof BOOTSTRAP_LOCATOR_VERSION
  readonly settingsRootCanonicalPath: string
}

/** File path and path syntax for the platform-owned bootstrap pointer. */
export interface ManagedBootstrapLocatorLocation {
  readonly filePath: string
  readonly pathStyle: ManagedPathStyle
  /** Canonical existing Harness home that cannot become a Launcher Settings root. */
  readonly nativeDshHomePath: string
}

/** Reads and writes the minimal settings-root pointer without manufacturing a default root. */
export class ManagedBootstrapLocatorStore {
  readonly #location: ManagedBootstrapLocatorLocation

  constructor(location: ManagedBootstrapLocatorLocation) {
    this.#location = location
  }

  /** Loads the selected Settings root or reports explicit first-run setup. */
  async load(): Promise<ManagedBootstrapLocator> {
    let text: string
    try {
      text = await readFile(this.#location.filePath, 'utf8')
    } catch (error) {
      if (isNodeCode(error, 'ENOENT')) {
        throw new ManagedRootError(
          'managed.missing_bootstrap_locator',
          'No Settings root has been registered.'
        )
      }
      throw persistenceError('Unable to read the Launcher bootstrap locator.', error)
    }
    return parseManagedBootstrapLocator(
      text,
      this.#location.pathStyle,
      this.#location.nativeDshHomePath
    )
  }

  /** Atomically locks recovery to the explicit Settings root before its dependent records are written. */
  async save(locator: ManagedBootstrapLocator): Promise<void> {
    validateManagedBootstrapLocator(
      locator,
      this.#location.pathStyle,
      this.#location.nativeDshHomePath
    )
    await assertNotSymlink(this.#location.filePath)
    const parent = nodePath.dirname(this.#location.filePath)
    try {
      await mkdir(parent, { recursive: true })
    } catch (error) {
      throw persistenceError('Unable to create the Launcher bootstrap directory.', error)
    }
    const temporaryPath = nodePath.join(
      parent,
      `.${nodePath.basename(this.#location.filePath)}.${randomUUID()}.tmp`
    )
    const serialized = `${JSON.stringify(locator, null, 2)}\n`
    try {
      const handle = await open(temporaryPath, 'wx', 0o600)
      try {
        await handle.writeFile(serialized, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporaryPath, this.#location.filePath)
      await syncParentDirectory(parent)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw persistenceError('Unable to persist the Launcher bootstrap locator.', error)
    }

    const reloaded = await this.load()
    if (JSON.stringify(reloaded) !== JSON.stringify(locator)) {
      throw new ManagedRootError(
        'managed.persistence_failed',
        'Bootstrap locator readback differs from the committed record.'
      )
    }
  }
}

/** Parses the exact bootstrap locator format and refuses unknown or future fields. */
export function parseManagedBootstrapLocator(
  text: string,
  style: ManagedPathStyle,
  nativeDshHomePath: string
): ManagedBootstrapLocator {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw persistenceError('Launcher bootstrap locator is not valid JSON.', error)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ManagedRootError(
      'managed.invalid_bootstrap_locator',
      'Launcher bootstrap locator must be an object.'
    )
  }
  const record = parsed as Record<string, unknown>
  const expected = ['format', 'version', 'settingsRootCanonicalPath']
  const actual = Object.keys(record)
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new ManagedRootError(
      'managed.invalid_bootstrap_locator',
      'Launcher bootstrap locator fields are invalid.'
    )
  }
  if (record.format !== BOOTSTRAP_LOCATOR_FORMAT) {
    throw new ManagedRootError(
      'managed.invalid_bootstrap_locator',
      'Launcher bootstrap locator format is invalid.'
    )
  }
  if (record.version !== BOOTSTRAP_LOCATOR_VERSION) {
    throw new ManagedRootError(
      'managed.unsupported_version',
      'Launcher bootstrap locator version is unsupported.'
    )
  }
  if (typeof record.settingsRootCanonicalPath !== 'string') {
    throw new ManagedRootError(
      'managed.invalid_bootstrap_locator',
      'Launcher Settings root path is invalid.'
    )
  }
  const locator: ManagedBootstrapLocator = {
    format: BOOTSTRAP_LOCATOR_FORMAT,
    version: BOOTSTRAP_LOCATOR_VERSION,
    settingsRootCanonicalPath: record.settingsRootCanonicalPath
  }
  validateManagedBootstrapLocator(locator, style, nativeDshHomePath)
  return locator
}

/** Validates a locator before it becomes the only path to Launcher state. */
export function validateManagedBootstrapLocator(
  locator: ManagedBootstrapLocator,
  style: ManagedPathStyle,
  nativeDshHomePath: string
): void {
  if (locator.format !== BOOTSTRAP_LOCATOR_FORMAT) {
    throw new ManagedRootError(
      'managed.invalid_bootstrap_locator',
      'Launcher bootstrap locator format is invalid.'
    )
  }
  if (locator.version !== BOOTSTRAP_LOCATOR_VERSION) {
    throw new ManagedRootError(
      'managed.unsupported_version',
      'Launcher bootstrap locator version is unsupported.'
    )
  }
  assertCanonicalRootPath(locator.settingsRootCanonicalPath, style)
  assertOutsideHarnessRuntimeHome(locator.settingsRootCanonicalPath, style)
  assertOutsideNativeDshHome(locator.settingsRootCanonicalPath, nativeDshHomePath, style)
}

/** Builds a fresh locator for a previously validated Settings root. */
export function createManagedBootstrapLocator(
  settingsRootCanonicalPath: string
): ManagedBootstrapLocator {
  return {
    format: BOOTSTRAP_LOCATOR_FORMAT,
    version: BOOTSTRAP_LOCATOR_VERSION,
    settingsRootCanonicalPath
  }
}

async function assertNotSymlink(filePath: string): Promise<void> {
  try {
    if ((await lstat(filePath)).isSymbolicLink()) {
      throw new ManagedRootError(
        'managed.persistence_failed',
        'Launcher bootstrap locator must not be a symbolic link.'
      )
    }
  } catch (error) {
    if (isNodeCode(error, 'ENOENT')) return
    if (error instanceof ManagedRootError) throw error
    throw persistenceError('Unable to inspect the Launcher bootstrap locator.', error)
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

function persistenceError(message: string, cause: unknown): ManagedRootError {
  return new ManagedRootError('managed.persistence_failed', message, {
    cause: cause instanceof Error ? cause.name : 'unknown'
  })
}

function isNodeCode(value: unknown, expected: string): boolean {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === expected)
}
