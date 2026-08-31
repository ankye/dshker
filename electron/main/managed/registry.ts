import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import nodePath from 'node:path'
import { randomUUID } from 'node:crypto'
import { ManagedRootError } from './errors'
import {
  MANAGED_ROOT_REGISTRY_FORMAT,
  MANAGED_ROOT_REGISTRY_VERSION,
  type ManagedRootRegistration,
  type ManagedRootRegistry,
  type ManagedWorkspaceBinding,
  isManagedRootKind
} from './model'
import {
  assertManagedRootLayout,
  assertOpaqueId,
  assertWorkspaceBinding,
  assertWorkspaceNamespacesDoNotOverlap,
  assertWorkspaceWorkingDirectoriesDoNotOverlap,
  type ManagedPathStyle
} from './validation'

type JsonRecord = Record<string, unknown>

/** Explicit location of one registry file below an already selected Settings root. */
export interface ManagedRootRegistryLocation {
  readonly filePath: string
  readonly pathStyle: ManagedPathStyle
  /** Canonical existing Harness home that must remain outside Launcher management. */
  readonly nativeDshHomePath: string
}

/** Owns strict parsing and atomic persistence of the Launcher root registry. */
export class ManagedRootRegistryStore {
  readonly #location: ManagedRootRegistryLocation

  constructor(location: ManagedRootRegistryLocation) {
    this.#location = location
  }

  /** Reads and validates the exact persisted registry. A missing document never becomes a default. */
  async load(): Promise<ManagedRootRegistry> {
    let text: string
    try {
      text = await readFile(this.#location.filePath, 'utf8')
    } catch (error) {
      if (isNodeCode(error, 'ENOENT')) {
        throw new ManagedRootError('managed.missing_registry', 'Managed root registry is missing.')
      }
      throw persistenceError('Unable to read the managed root registry.', error)
    }
    return parseManagedRootRegistry(
      text,
      this.#location.pathStyle,
      this.#location.nativeDshHomePath
    )
  }

  /** Writes one fully validated registry through an atomic replacement and readback. */
  async save(registry: ManagedRootRegistry): Promise<void> {
    validateManagedRootRegistry(
      registry,
      this.#location.pathStyle,
      this.#location.nativeDshHomePath
    )
    await assertNotSymlink(this.#location.filePath)
    const parent = nodePath.dirname(this.#location.filePath)
    const temporaryPath = nodePath.join(
      parent,
      `.${nodePath.basename(this.#location.filePath)}.${randomUUID()}.tmp`
    )
    const serialized = `${JSON.stringify(registry, null, 2)}\n`

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
      throw persistenceError('Unable to persist the managed root registry.', error)
    }

    const reloaded = await this.load()
    if (JSON.stringify(reloaded) !== JSON.stringify(registry)) {
      throw new ManagedRootError(
        'managed.persistence_failed',
        'Managed root registry readback differs from the committed record.'
      )
    }
  }
}

/** Strictly parses the Launcher-owned persisted registry format. */
export function parseManagedRootRegistry(
  text: string,
  style: ManagedPathStyle,
  nativeDshHomePath: string
): ManagedRootRegistry {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw persistenceError('Managed root registry is not valid JSON.', error)
  }

  const record = requireRecord(value, 'Managed root registry')
  requireExactKeys(record, ['format', 'version', 'roots', 'workspaces'], 'Managed root registry')
  if (record.format !== MANAGED_ROOT_REGISTRY_FORMAT) {
    throw new ManagedRootError('managed.invalid_record', 'Managed root registry format is invalid.')
  }
  if (record.version !== MANAGED_ROOT_REGISTRY_VERSION) {
    throw new ManagedRootError(
      'managed.unsupported_version',
      'Managed root registry version is unsupported.'
    )
  }
  if (!Array.isArray(record.roots) || !Array.isArray(record.workspaces)) {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Managed root registry collections are invalid.'
    )
  }

  const registry: ManagedRootRegistry = {
    format: MANAGED_ROOT_REGISTRY_FORMAT,
    version: MANAGED_ROOT_REGISTRY_VERSION,
    roots: record.roots.map(parseRoot),
    workspaces: record.workspaces.map(parseWorkspace)
  }
  validateManagedRootRegistry(registry, style, nativeDshHomePath)
  return registry
}

/** Verifies registry topology independently of persistence. */
export function validateManagedRootRegistry(
  registry: ManagedRootRegistry,
  style: ManagedPathStyle,
  nativeDshHomePath: string
): void {
  assertManagedRootLayout(registry.roots, style, nativeDshHomePath)
  for (const workspace of registry.workspaces) {
    assertWorkspaceBinding(workspace, registry.roots, style, nativeDshHomePath)
  }
  assertWorkspaceNamespacesDoNotOverlap(registry.workspaces)
  assertWorkspaceWorkingDirectoriesDoNotOverlap(registry.workspaces, style)
}

function parseRoot(value: unknown): ManagedRootRegistration {
  const record = requireRecord(value, 'Managed root')
  requireExactKeys(record, ['rootId', 'kind', 'canonicalPath'], 'Managed root')
  assertOpaqueId(record.rootId, 'Root id')
  if (typeof record.kind !== 'string' || !isManagedRootKind(record.kind)) {
    throw new ManagedRootError('managed.invalid_record', 'Managed root kind is invalid.')
  }
  if (typeof record.canonicalPath !== 'string') {
    throw new ManagedRootError('managed.invalid_record', 'Managed root canonical path is invalid.')
  }
  return { rootId: record.rootId, kind: record.kind, canonicalPath: record.canonicalPath }
}

function parseWorkspace(value: unknown): ManagedWorkspaceBinding {
  const record = requireRecord(value, 'Managed workspace')
  requireExactKeys(
    record,
    [
      'workspaceId',
      'displayName',
      'workingDirectoryCapabilityId',
      'workingDirectoryCanonicalPath',
      'rootNamespaces'
    ],
    'Managed workspace'
  )
  assertOpaqueId(record.workspaceId, 'Workspace id')
  if (typeof record.displayName !== 'string') {
    throw new ManagedRootError('managed.invalid_record', 'Workspace display name is invalid.')
  }
  assertOpaqueId(record.workingDirectoryCapabilityId, 'Working-directory capability id')
  if (!Array.isArray(record.rootNamespaces)) {
    throw new ManagedRootError('managed.invalid_record', 'Workspace root namespaces are invalid.')
  }
  if (typeof record.workingDirectoryCanonicalPath !== 'string') {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Workspace working-directory path is invalid.'
    )
  }
  return {
    workspaceId: record.workspaceId,
    displayName: record.displayName,
    workingDirectoryCapabilityId: record.workingDirectoryCapabilityId,
    workingDirectoryCanonicalPath: record.workingDirectoryCanonicalPath,
    rootNamespaces: record.rootNamespaces.map(parseWorkspaceRootNamespace)
  }
}

function parseWorkspaceRootNamespace(value: unknown): { rootId: string; namespace: string } {
  const record = requireRecord(value, 'Workspace root namespace')
  requireExactKeys(record, ['rootId', 'namespace'], 'Workspace root namespace')
  assertOpaqueId(record.rootId, 'Workspace root id')
  if (typeof record.namespace !== 'string') {
    throw new ManagedRootError('managed.invalid_record', 'Workspace namespace is invalid.')
  }
  return { rootId: record.rootId, namespace: record.namespace }
}

function requireRecord(value: unknown, subject: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManagedRootError('managed.invalid_record', `${subject} must be an object.`)
  }
  return value as JsonRecord
}

function requireExactKeys(record: JsonRecord, expected: readonly string[], subject: string): void {
  const actual = Object.keys(record)
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new ManagedRootError('managed.invalid_record', `${subject} fields are invalid.`)
  }
}

async function assertNotSymlink(filePath: string): Promise<void> {
  try {
    if ((await lstat(filePath)).isSymbolicLink()) {
      throw new ManagedRootError(
        'managed.persistence_failed',
        'Managed root registry path must not be a symbolic link.'
      )
    }
  } catch (error) {
    if (isNodeCode(error, 'ENOENT')) return
    if (error instanceof ManagedRootError) throw error
    throw persistenceError('Unable to inspect the managed root registry path.', error)
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
