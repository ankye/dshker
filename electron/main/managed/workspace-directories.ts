import { lstat, mkdir, rmdir } from 'node:fs/promises'
import { ManagedRootError } from './errors'
import type { ManagedRootKind, ManagedRootRegistration, ManagedWorkspaceBinding } from './model'
import { pathApiFor, resolveWorkspaceNamespace, type ManagedPathStyle } from './validation'

/** Canonical per-workspace directories under every Launcher-owned root. */
export interface ManagedWorkspaceDirectories {
  readonly roots: Readonly<Record<ManagedRootKind, string>>
}

/** Creates the exact empty namespace directories before their workspace binding becomes durable. */
export async function createManagedWorkspaceDirectories(
  roots: readonly ManagedRootRegistration[],
  workspace: ManagedWorkspaceBinding,
  style: ManagedPathStyle
): Promise<ManagedWorkspaceDirectories> {
  const created: string[] = []
  try {
    const directories = await resolveWorkspaceDirectories(roots, workspace, style, created)
    return Object.freeze({ roots: directories })
  } catch (error) {
    await removeCreatedDirectories(created)
    throw error
  }
}

/** Reads existing namespace directories and refuses a missing or substituted workspace directory. */
export async function readManagedWorkspaceDirectories(
  roots: readonly ManagedRootRegistration[],
  workspace: ManagedWorkspaceBinding,
  style: ManagedPathStyle
): Promise<ManagedWorkspaceDirectories> {
  const directories = await resolveWorkspaceDirectories(roots, workspace, style)
  for (const directory of Object.values(directories)) {
    await assertDirectDirectory(directory, 'Managed workspace directory')
  }
  return Object.freeze({ roots: directories })
}

/** Removes only directories created for a workspace before its registry record became durable. */
export async function removeManagedWorkspaceDirectories(
  directories: ManagedWorkspaceDirectories
): Promise<void> {
  await removeCreatedDirectories(Object.values(directories.roots))
}

async function resolveWorkspaceDirectories(
  roots: readonly ManagedRootRegistration[],
  workspace: ManagedWorkspaceBinding,
  style: ManagedPathStyle,
  created?: string[]
): Promise<Record<ManagedRootKind, string>> {
  const pathApi = pathApiFor(style)
  const directories = {} as Record<ManagedRootKind, string>
  for (const root of roots) {
    const binding = workspace.rootNamespaces.find((entry) => entry.rootId === root.rootId)
    if (!binding) {
      throw new ManagedRootError(
        'managed.invalid_record',
        'Workspace is missing a registered root namespace.'
      )
    }
    const target = resolveWorkspaceNamespace(root, binding.namespace, style)
    if (created) {
      await createWorkspaceNamespace(root.canonicalPath, binding.namespace, target, style, created)
    }
    if (pathApi.normalize(target) !== target) {
      throw new ManagedRootError(
        'managed.namespace_invalid',
        'Workspace namespace target is not canonical.'
      )
    }
    directories[root.kind] = target
  }
  return directories
}

async function createWorkspaceNamespace(
  rootPath: string,
  namespace: string,
  target: string,
  style: ManagedPathStyle,
  created: string[]
): Promise<void> {
  const pathApi = pathApiFor(style)
  const segments = namespace.split('/')
  let current = rootPath
  for (const [index, segment] of segments.entries()) {
    current = pathApi.join(current, segment)
    const finalDirectory = index === segments.length - 1
    await createDirectDirectory(current, finalDirectory, created)
  }
  if (current !== target) {
    throw new ManagedRootError(
      'managed.namespace_invalid',
      'Workspace namespace target does not match its registered path.'
    )
  }
}

async function createDirectDirectory(
  directory: string,
  finalDirectory: boolean,
  created: string[]
): Promise<void> {
  try {
    await mkdir(directory)
    created.push(directory)
  } catch (error) {
    if (!isNodeCode(error, 'EEXIST')) {
      throw new ManagedRootError(
        'managed.persistence_failed',
        'Workspace namespace directory could not be created.',
        { cause: error instanceof Error ? error.name : 'unknown' }
      )
    }
    if (finalDirectory) {
      throw new ManagedRootError(
        'managed.namespace_overlap',
        'Workspace namespace directory already exists.'
      )
    }
  }
  await assertDirectDirectory(directory, 'Workspace namespace directory')
}

async function assertDirectDirectory(directory: string, subject: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>
  try {
    metadata = await lstat(directory)
  } catch (error) {
    throw new ManagedRootError('managed.root_not_directory', `${subject} is unavailable.`, {
      cause: error instanceof Error ? error.name : 'unknown'
    })
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ManagedRootError(
      'managed.root_symbolic_link',
      `${subject} must be a direct non-symbolic-link directory.`
    )
  }
}

async function removeCreatedDirectories(created: readonly string[]): Promise<void> {
  for (const directory of [...created].reverse()) {
    try {
      await rmdir(directory)
    } catch (error) {
      throw new ManagedRootError(
        'managed.persistence_failed',
        'A partially created workspace namespace could not be removed.',
        { cause: error instanceof Error ? error.name : 'unknown' }
      )
    }
  }
}

function isNodeCode(value: unknown, expected: string): boolean {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === expected)
}
