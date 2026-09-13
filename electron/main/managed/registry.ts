import type { CoreRootsLocation, CoreRootsPort } from '../core/roots'
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

/**
 * The Launcher root registry, persisted by the core.
 *
 * The shell used to write this file itself. The core owns it now — the format,
 * the version and the file name are unchanged, so an existing registry is read
 * as it always was — and this store is the only way the shell reaches it. That
 * makes the core load-bearing for the Launcher's own configuration, which is the
 * point of the phase: exactly one writer, and no second implementation that can
 * drift from the rules the core enforces.
 */
export class ManagedRootRegistryStore {
  readonly #location: ManagedRootRegistryLocation
  readonly #roots: CoreRootsPort | undefined

  constructor(location: ManagedRootRegistryLocation, roots?: CoreRootsPort) {
    this.#location = location
    this.#roots = roots
  }

  /** Reads and validates the exact persisted registry. A missing document never becomes a default. */
  async load(): Promise<ManagedRootRegistry> {
    return (await this.#port()).inspect(this.#coreLocation())
  }

  /**
   * Commits one fully validated registry.
   *
   * The core validates the whole document again, publishes it atomically and
   * proves the published bytes by reading them back, so this side only has to
   * check that what came back is what it asked for.
   */
  async save(registry: ManagedRootRegistry): Promise<void> {
    const committed = await (await this.#port()).commit(this.#coreLocation(), registry)
    if (JSON.stringify(committed) !== JSON.stringify(registry)) {
      throw new ManagedRootError(
        'managed.persistence_failed',
        'Managed root registry readback differs from the committed record.'
      )
    }
  }

  /** The core is the only writer, so a shell without one has no registry at all. */
  async #port(): Promise<CoreRootsPort> {
    if (this.#roots === undefined) {
      throw new ManagedRootError(
        'managed.core_unavailable',
        'The headless core is required to read or write the managed root registry.'
      )
    }
    return this.#roots
  }

  #coreLocation(): CoreRootsLocation {
    return {
      filePath: this.#location.filePath,
      nativeDshHome: this.#location.nativeDshHomePath,
      pathStyle: this.#location.pathStyle
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
  return parseManagedRootRegistryValue(value, style, nativeDshHomePath)
}

/**
 * The same validation for a document that is already decoded, which is how the
 * core's answer is checked: a value off the private channel goes through exactly
 * the rules the shell applied while it owned the file.
 */
export function parseManagedRootRegistryValue(
  value: unknown,
  style: ManagedPathStyle,
  nativeDshHomePath: string
): ManagedRootRegistry {
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

function persistenceError(message: string, cause: unknown): ManagedRootError {
  return new ManagedRootError('managed.persistence_failed', message, {
    cause: cause instanceof Error ? cause.name : 'unknown'
  })
}
