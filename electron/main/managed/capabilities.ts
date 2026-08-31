import { randomUUID } from 'node:crypto'
import { ManagedRootError } from './errors'
import type { ManagedRootKind } from './model'
import { assertOpaqueId } from './validation'

/** Native directory-selection purposes that the renderer can request by name. */
export type DirectorySelectionPurpose =
  | `managed-root:${ManagedRootKind}`
  | 'workspace-working-directory'

/** Opaque one-time authority to use a native-selected directory for one declared purpose. */
export interface DirectorySelectionCapability {
  readonly capabilityId: string
  readonly purpose: DirectorySelectionPurpose
  readonly canonicalPath: string
  readonly displayName: string
  readonly expiresAt: number
}

/** Native picker abstraction keeps Electron dialog ownership out of deterministic tests. */
export interface DirectoryPicker {
  pickDirectory(purpose: DirectorySelectionPurpose): Promise<string | undefined>
}

/** Issues and consumes purpose-bound directory capabilities without exposing arbitrary path inputs. */
export class DirectorySelectionCapabilities {
  readonly #ttlMilliseconds: number
  readonly #now: () => number
  readonly #capabilities = new Map<string, DirectorySelectionCapability>()

  constructor(options: { readonly ttlMilliseconds: number; readonly now?: () => number }) {
    if (!Number.isSafeInteger(options.ttlMilliseconds) || options.ttlMilliseconds <= 0) {
      throw new ManagedRootError(
        'managed.selection_invalid',
        'Directory capability lifetime is invalid.'
      )
    }
    this.#ttlMilliseconds = options.ttlMilliseconds
    this.#now = options.now ?? Date.now
  }

  /** Records a selected directory and returns only an opaque capability to the renderer. */
  issue(
    purpose: DirectorySelectionPurpose,
    canonicalPath: string,
    displayName: string
  ): DirectorySelectionCapability {
    assertDirectorySelectionPurpose(purpose)
    if (typeof displayName !== 'string' || displayName.length === 0 || displayName.length > 512) {
      throw new ManagedRootError(
        'managed.selection_invalid',
        'Directory selection display name is invalid.'
      )
    }
    const capability: DirectorySelectionCapability = Object.freeze({
      capabilityId: `cap_${randomUUID().replace(/-/g, '')}`,
      purpose,
      canonicalPath,
      displayName,
      expiresAt: this.#now() + this.#ttlMilliseconds
    })
    this.#capabilities.set(capability.capabilityId, capability)
    return capability
  }

  /** Resolves a capability only for the exact purpose it was issued to serve. */
  inspect(capabilityId: unknown, purpose: DirectorySelectionPurpose): DirectorySelectionCapability {
    assertOpaqueId(capabilityId, 'Directory capability id')
    assertDirectorySelectionPurpose(purpose)
    const capability = this.#capabilities.get(capabilityId)
    if (!capability || capability.purpose !== purpose) {
      throw new ManagedRootError(
        'managed.selection_invalid',
        'Directory capability is not valid for this operation.'
      )
    }
    if (capability.expiresAt <= this.#now()) {
      this.#capabilities.delete(capabilityId)
      throw new ManagedRootError(
        'managed.selection_expired',
        'Directory capability expired before use.'
      )
    }
    return capability
  }

  /** Consumes a capability so a later IPC call cannot silently replay its path authority. */
  consume(capabilityId: unknown, purpose: DirectorySelectionPurpose): DirectorySelectionCapability {
    const capability = this.inspect(capabilityId, purpose)
    this.#capabilities.delete(capability.capabilityId)
    return capability
  }
}

/** Rejects undeclared native picker purposes before opening a platform dialog. */
export function assertDirectorySelectionPurpose(
  value: unknown
): asserts value is DirectorySelectionPurpose {
  if (
    value !== 'workspace-working-directory' &&
    (typeof value !== 'string' ||
      !value.startsWith('managed-root:') ||
      !isManagedRootPurpose(value))
  ) {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Directory selection purpose is invalid.'
    )
  }
}

function isManagedRootPurpose(value: string): value is `managed-root:${ManagedRootKind}` {
  const kind = value.slice('managed-root:'.length)
  return kind === 'harness' || kind === 'plugins' || kind === 'presets' || kind === 'settings'
}
