import { access, lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { ManagedRootError } from './errors'
import type { ManagedPathStyle } from './validation'
import { assertCanonicalRootPath, pathApiFor } from './validation'

/** Resolves an existing, non-link directory chosen by the native process. */
export async function canonicalizeSelectedDirectory(
  selectedPath: string,
  style: ManagedPathStyle
): Promise<string> {
  let selectedStats: Awaited<ReturnType<typeof lstat>>
  try {
    selectedStats = await lstat(selectedPath)
  } catch (error) {
    throw directoryInspectionError(
      'managed.root_not_directory',
      'Selected directory is unavailable.',
      error
    )
  }

  if (selectedStats.isSymbolicLink()) {
    throw new ManagedRootError(
      'managed.root_symbolic_link',
      'Selected directory must not be a symbolic link.'
    )
  }
  if (!selectedStats.isDirectory()) {
    throw new ManagedRootError('managed.root_not_directory', 'Selected path must be a directory.')
  }

  let canonicalPath: string
  try {
    canonicalPath = await realpath(selectedPath)
  } catch (error) {
    throw directoryInspectionError(
      'managed.root_not_directory',
      'Selected directory cannot be resolved.',
      error
    )
  }
  assertCanonicalRootPath(canonicalPath, style)

  let canonicalStats: Awaited<ReturnType<typeof lstat>>
  try {
    canonicalStats = await lstat(canonicalPath)
  } catch (error) {
    throw directoryInspectionError(
      'managed.root_not_directory',
      'Resolved directory is unavailable.',
      error
    )
  }
  if (canonicalStats.isSymbolicLink()) {
    throw new ManagedRootError(
      'managed.root_symbolic_link',
      'Resolved directory must not be a symbolic link.'
    )
  }
  if (!canonicalStats.isDirectory()) {
    throw new ManagedRootError('managed.root_not_directory', 'Resolved path must be a directory.')
  }

  try {
    await access(canonicalPath, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK)
  } catch (error) {
    throw directoryInspectionError(
      'managed.root_not_writable',
      'Selected directory is not writable.',
      error
    )
  }
  return canonicalPath
}

/** Requires a fresh root directory so Launcher-owned records cannot mix with unknown content. */
export async function assertEmptyManagedRoot(canonicalPath: string): Promise<void> {
  let entries: readonly string[]
  try {
    entries = await readdir(canonicalPath)
  } catch (error) {
    throw directoryInspectionError(
      'managed.persistence_failed',
      'Managed root contents cannot be inspected.',
      error
    )
  }
  if (entries.length > 0) {
    throw new ManagedRootError(
      'managed.root_not_empty',
      'Each managed root must be an empty directory before initial registration.'
    )
  }
}

/** Creates and validates the fixed Launcher registry directory below the selected Settings root. */
export async function ensureRegistryDirectory(
  settingsRoot: string,
  style: ManagedPathStyle
): Promise<string> {
  const pathApi = pathApiFor(style)
  const registryDirectory = pathApi.join(settingsRoot, 'dsh-launcher')
  if (!isStrictChild(settingsRoot, registryDirectory, style)) {
    throw new ManagedRootError(
      'managed.persistence_failed',
      'Registry directory escapes the selected Settings root.'
    )
  }

  try {
    await mkdir(registryDirectory)
  } catch (error) {
    if (!isNodeCode(error, 'EEXIST')) {
      throw directoryInspectionError(
        'managed.persistence_failed',
        'Unable to create the Launcher registry directory.',
        error
      )
    }
  }

  let stats: Awaited<ReturnType<typeof lstat>>
  try {
    stats = await lstat(registryDirectory)
  } catch (error) {
    throw directoryInspectionError(
      'managed.persistence_failed',
      'Launcher registry directory is unavailable.',
      error
    )
  }
  if (stats.isSymbolicLink()) {
    throw new ManagedRootError(
      'managed.root_symbolic_link',
      'Launcher registry directory must not be a symbolic link.'
    )
  }
  if (!stats.isDirectory()) {
    throw new ManagedRootError(
      'managed.persistence_failed',
      'Launcher registry location is not a directory.'
    )
  }
  return registryDirectory
}

/** Derives the only registry-file location accepted below the selected Settings root. */
export function managedRootRegistryFilePath(settingsRoot: string, style: ManagedPathStyle): string {
  const pathApi = pathApiFor(style)
  const registryDirectory = pathApi.join(settingsRoot, 'dsh-launcher')
  const filePath = pathApi.join(registryDirectory, 'managed-root-registry.json')
  if (
    !isStrictChild(settingsRoot, registryDirectory, style) ||
    !isStrictChild(registryDirectory, filePath, style)
  ) {
    throw new ManagedRootError(
      'managed.persistence_failed',
      'Registry file path escapes the selected Settings root.'
    )
  }
  return filePath
}

/** Confirms an already registered root remains an accessible non-link directory. */
export async function assertRegisteredDirectory(
  canonicalPath: string,
  style: ManagedPathStyle
): Promise<void> {
  const observed = await canonicalizeSelectedDirectory(canonicalPath, style)
  if (observed !== canonicalPath) {
    throw new ManagedRootError(
      'managed.root_path_invalid',
      'Registered directory no longer resolves to its recorded path.'
    )
  }
}

function isStrictChild(parent: string, child: string, style: ManagedPathStyle): boolean {
  const pathApi = pathApiFor(style)
  const relative = pathApi.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !pathApi.isAbsolute(relative)
}

function directoryInspectionError(
  code: Extract<
    ManagedRootError['code'],
    'managed.root_not_directory' | 'managed.root_not_writable' | 'managed.persistence_failed'
  >,
  message: string,
  cause: unknown
): ManagedRootError {
  return new ManagedRootError(code, message, {
    cause: cause instanceof Error ? cause.name : 'unknown'
  })
}

function isNodeCode(value: unknown, expected: string): boolean {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === expected)
}
