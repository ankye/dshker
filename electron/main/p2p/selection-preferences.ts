import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import nodePath from 'node:path'
import { ManagedRootError } from '../managed/errors'

/** Persisted identity for the network a service's owner last chose by hand. */
export const P2P_SELECTION_FORMAT = 'dsh-launcher.p2p-selection' as const

/** First strict selection revision. */
export const P2P_SELECTION_VERSION = 1 as const

/** One remembered choice: the account that made it, and the network it named. */
export interface P2PSelectionEntry {
  readonly userId: string
  readonly networkId: string
}

/** Exact versioned document written below the registered Settings root. */
export interface P2PSelectionRecord {
  readonly format: typeof P2P_SELECTION_FORMAT
  readonly version: typeof P2P_SELECTION_VERSION
  readonly services: Readonly<Record<string, P2PSelectionEntry>>
}

/** Resolves the current registered Settings root for every public store operation. */
export interface P2PSelectionStoreOptions {
  readonly resolveSettingsRoot: () => Promise<string>
}

/**
 * Remembers which network an owner selected, so a returning owner lands where
 * they left instead of re-picking from the same list.
 *
 * Only an explicit selection is ever recorded: an automatic one is not a
 * decision, and treating it as one would freeze a default into a user intent.
 * A remembered network is handed back only to the account that chose it.
 */
export class P2PSelectionStore {
  readonly #resolveSettingsRoot: () => Promise<string>

  constructor(options: P2PSelectionStoreOptions) {
    this.#resolveSettingsRoot = options.resolveSettingsRoot
  }

  /** This service's remembered network for one account, if any. */
  async remembered(serviceId: string, userId: string): Promise<string | undefined> {
    assertServiceId(serviceId)
    assertHexId(userId, 12, 'userId')
    const record = await this.#load()
    const entry = record.services[serviceId]
    return entry && entry.userId === userId ? entry.networkId : undefined
  }

  /** Records one explicit choice, replacing whatever this service remembered. */
  async remember(serviceId: string, userId: string, networkId: string): Promise<void> {
    assertServiceId(serviceId)
    assertHexId(userId, 12, 'userId')
    assertHexId(networkId, 12, 'networkId')
    const record = await this.#load()
    await this.#save({
      ...record,
      services: { ...record.services, [serviceId]: { userId, networkId } }
    })
  }

  /** Drops a service's memory, for a sign-out or a credential that is gone. */
  async forget(serviceId: string): Promise<void> {
    assertServiceId(serviceId)
    const record = await this.#load()
    if (!(serviceId in record.services)) return
    const services = { ...record.services }
    delete services[serviceId]
    await this.#save({ ...record, services })
  }

  async #load(): Promise<P2PSelectionRecord> {
    const filePath = await this.#resolveFilePath()
    const parent = nodePath.dirname(filePath)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    await assertNotSymlink(parent)
    await assertNotSymlink(filePath)
    let text: string
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error) {
      if (!isNodeCode(error, 'ENOENT'))
        throw persistenceError('Unable to read P2P selection.', error)
      const created = createP2PSelectionRecord({})
      await this.#write(filePath, created)
      return created
    }
    return parseP2PSelection(text)
  }

  async #save(record: P2PSelectionRecord): Promise<void> {
    const filePath = await this.#resolveFilePath()
    await this.#write(filePath, record)
  }

  async #write(filePath: string, record: P2PSelectionRecord): Promise<void> {
    const parent = nodePath.dirname(filePath)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    await assertNotSymlink(parent)
    await assertNotSymlink(filePath)
    const temporaryPath = nodePath.join(
      parent,
      `.${nodePath.basename(filePath)}.${randomUUID()}.tmp`
    )
    const serialized = `${JSON.stringify(record, null, 2)}\n`
    try {
      await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, filePath)
      await chmod(filePath, 0o600)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw persistenceError('Unable to persist P2P selection.', error)
    }
  }

  async #resolveFilePath(): Promise<string> {
    const settingsRoot = await this.#resolveSettingsRoot()
    return p2pSelectionFilePath(settingsRoot)
  }
}

/** Derives the only selection-file location below the registered Settings root. */
export function p2pSelectionFilePath(settingsRoot: string): string {
  const launcherDirectory = nodePath.join(settingsRoot, 'dsh-launcher')
  const filePath = nodePath.join(launcherDirectory, 'p2p-selection.json')
  if (
    !isStrictChild(settingsRoot, launcherDirectory) ||
    !isStrictChild(launcherDirectory, filePath)
  ) {
    throw new ManagedRootError(
      'managed.persistence_failed',
      'P2P selection path escapes the registered Settings root.'
    )
  }
  return filePath
}

/** Builds the exact record for a set of remembered choices. */
export function createP2PSelectionRecord(
  services: Readonly<Record<string, P2PSelectionEntry>>
): P2PSelectionRecord {
  return { format: P2P_SELECTION_FORMAT, version: P2P_SELECTION_VERSION, services }
}

/** Parses every persisted field and refuses malformed, unknown, or future records. */
export function parseP2PSelection(text: string): P2PSelectionRecord {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw persistenceError('P2P selection is not valid JSON.', error)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManagedRootError('managed.invalid_record', 'P2P selection must be an object.')
  }
  const record = value as Record<string, unknown>
  const expected = ['format', 'version', 'services']
  const actual = Object.keys(record)
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new ManagedRootError('managed.invalid_record', 'P2P selection fields are invalid.')
  }
  if (record.format !== P2P_SELECTION_FORMAT) {
    throw new ManagedRootError('managed.invalid_record', 'P2P selection format is invalid.')
  }
  if (record.version !== P2P_SELECTION_VERSION) {
    throw new ManagedRootError(
      'managed.unsupported_version',
      'P2P selection version is unsupported.'
    )
  }
  if (!record.services || typeof record.services !== 'object' || Array.isArray(record.services)) {
    throw new ManagedRootError('managed.invalid_record', 'P2P selection services are invalid.')
  }
  const services: Record<string, P2PSelectionEntry> = {}
  for (const [serviceId, entry] of Object.entries(record.services as Record<string, unknown>)) {
    assertServiceId(serviceId)
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ManagedRootError('managed.invalid_record', 'P2P selection entry is invalid.')
    }
    const fields = entry as Record<string, unknown>
    if (Object.keys(fields).length !== 2 || !('userId' in fields) || !('networkId' in fields)) {
      throw new ManagedRootError(
        'managed.invalid_record',
        'P2P selection entry fields are invalid.'
      )
    }
    assertHexId(fields.userId, 12, 'userId')
    assertHexId(fields.networkId, 12, 'networkId')
    services[serviceId] = { userId: fields.userId, networkId: fields.networkId }
  }
  return createP2PSelectionRecord(services)
}

function assertServiceId(value: unknown): asserts value is string {
  assertHexId(value, 12, 'service id')
}

/** Every persisted identifier is a fixed-length lowercase hex string, or refused. */
function assertHexId(value: unknown, length: number, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length !== length || !/^[a-f0-9]+$/.test(value)) {
    throw new ManagedRootError('managed.invalid_record', `P2P selection ${field} is invalid.`)
  }
}

function isStrictChild(parent: string, child: string): boolean {
  const relative = nodePath.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !nodePath.isAbsolute(relative)
}

async function assertNotSymlink(target: string): Promise<void> {
  try {
    const stats = await lstat(target)
    if (stats.isSymbolicLink()) {
      throw new ManagedRootError('managed.persistence_failed', `Refusing a symlink at ${target}.`)
    }
  } catch (error) {
    if (isNodeCode(error, 'ENOENT')) return
    throw error
  }
}

function isNodeCode(error: unknown, code: string): boolean {
  return Boolean(error) && typeof error === 'object' && (error as { code?: string }).code === code
}

function persistenceError(message: string, cause: unknown): ManagedRootError {
  return new ManagedRootError('managed.persistence_failed', message, {
    cause: cause instanceof Error ? cause.message : String(cause)
  })
}
