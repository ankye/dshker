import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import nodePath from 'node:path'
import { ManagedRootError } from './errors'
import { assertOpaqueId } from './validation'

/** The only external command entries the Launcher may request through a native file chooser. */
export type ExecutableSelectionPurpose = 'git' | 'node' | 'pnpm'

/** One opaque, short-lived authority to use an explicitly selected external executable. */
export interface ExecutableSelectionCapability {
  readonly capabilityId: string
  readonly purpose: ExecutableSelectionPurpose
  readonly canonicalPath: string
  readonly displayName: string
  readonly expiresAt: number
}

/** Electron-independent file-picker seam for executable registration. */
export interface ExecutablePicker {
  pickExecutable(purpose: ExecutableSelectionPurpose): Promise<string | undefined>
}

/** Issues and consumes one-time executable authorities without exposing an arbitrary renderer path API. */
export class ExecutableSelectionCapabilities {
  readonly #ttlMilliseconds: number
  readonly #now: () => number
  readonly #capabilities = new Map<string, ExecutableSelectionCapability>()

  constructor(options: { readonly ttlMilliseconds: number; readonly now?: () => number }) {
    if (!Number.isSafeInteger(options.ttlMilliseconds) || options.ttlMilliseconds <= 0) {
      throw new ManagedRootError(
        'managed.selection_invalid',
        'Executable capability lifetime is invalid.'
      )
    }
    this.#ttlMilliseconds = options.ttlMilliseconds
    this.#now = options.now ?? Date.now
  }

  /** Issues one purpose-bound capability after a native picker supplied an exact canonical file. */
  issue(
    purpose: ExecutableSelectionPurpose,
    canonicalPath: string,
    displayName: string
  ): ExecutableSelectionCapability {
    assertExecutableSelectionPurpose(purpose)
    if (typeof displayName !== 'string' || displayName.length === 0 || displayName.length > 512) {
      throw new ManagedRootError(
        'managed.selection_invalid',
        'Executable selection display name is invalid.'
      )
    }
    const capability: ExecutableSelectionCapability = Object.freeze({
      capabilityId: `exec_${randomUUID().replace(/-/g, '')}`,
      purpose,
      canonicalPath,
      displayName,
      expiresAt: this.#now() + this.#ttlMilliseconds
    })
    this.#capabilities.set(capability.capabilityId, capability)
    return capability
  }

  /** Reads a live exact-purpose capability without consuming it. */
  inspect(
    capabilityId: unknown,
    purpose: ExecutableSelectionPurpose
  ): ExecutableSelectionCapability {
    assertOpaqueId(capabilityId, 'Executable capability id')
    assertExecutableSelectionPurpose(purpose)
    const capability = this.#capabilities.get(capabilityId)
    if (!capability || capability.purpose !== purpose) {
      throw new ManagedRootError(
        'managed.selection_invalid',
        'Executable capability is not valid for this operation.'
      )
    }
    if (capability.expiresAt <= this.#now()) {
      this.#capabilities.delete(capabilityId)
      throw new ManagedRootError(
        'managed.selection_expired',
        'Executable capability expired before use.'
      )
    }
    return capability
  }

  /** Consumes an executable authority so it cannot be silently replayed by a later request. */
  consume(
    capabilityId: unknown,
    purpose: ExecutableSelectionPurpose
  ): ExecutableSelectionCapability {
    const capability = this.inspect(capabilityId, purpose)
    this.#capabilities.delete(capability.capabilityId)
    return capability
  }
}

/** Resolves a native-selected regular file and refuses aliases, directories, and special files. */
export async function canonicalizeSelectedExecutable(selectedPath: string): Promise<string> {
  if (
    typeof selectedPath !== 'string' ||
    selectedPath.length === 0 ||
    selectedPath.includes('\u0000') ||
    !nodePath.isAbsolute(selectedPath) ||
    nodePath.normalize(selectedPath) !== selectedPath ||
    nodePath.parse(selectedPath).root === selectedPath
  ) {
    throw new ManagedRootError('managed.selection_invalid', 'Selected executable path is invalid.')
  }
  let selected: Awaited<ReturnType<typeof lstat>>
  try {
    selected = await lstat(selectedPath)
  } catch (error) {
    throw executableInspectionFailure('Selected executable is unavailable.', error)
  }
  if (!selected.isSymbolicLink() && !selected.isFile()) {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Selected executable must be a regular file or a link to one.'
    )
  }
  let canonicalPath: string
  try {
    canonicalPath = await realpath(selectedPath)
  } catch (error) {
    throw executableInspectionFailure('Selected executable cannot be resolved.', error)
  }
  if (
    !nodePath.isAbsolute(canonicalPath) ||
    nodePath.normalize(canonicalPath) !== canonicalPath ||
    nodePath.parse(canonicalPath).root === canonicalPath
  ) {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Selected executable resolved to an invalid path.'
    )
  }
  let canonical: Awaited<ReturnType<typeof lstat>>
  try {
    canonical = await lstat(canonicalPath)
  } catch (error) {
    throw executableInspectionFailure('Resolved executable is unavailable.', error)
  }
  if (canonical.isSymbolicLink() || !canonical.isFile()) {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Resolved executable must be a direct regular file.'
    )
  }
  return canonicalPath
}

/** Refuses every renderer-supplied executable role outside the product allowlist. */
export function assertExecutableSelectionPurpose(
  value: unknown
): asserts value is ExecutableSelectionPurpose {
  if (value !== 'git' && value !== 'node' && value !== 'pnpm') {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Executable selection purpose is invalid.'
    )
  }
}

function executableInspectionFailure(message: string, cause: unknown): ManagedRootError {
  return new ManagedRootError('managed.selection_invalid', message, {
    cause: cause instanceof Error ? cause.name : 'unknown'
  })
}
