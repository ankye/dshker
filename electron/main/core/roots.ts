// The main-only view of the core's managed-root registry.
//
// The document shape is the one the shell has always written, so routing it
// through the core changes who persists it and nothing about what is persisted:
// same format, same version, same file name. Only Electron main holds one of
// these, and no path or identifier ever reaches the renderer through it.
import { parseManagedRootRegistryValue } from '../managed/registry'
import type { ManagedRootRegistry } from '../managed/model'
import type { ManagedPathStyle } from '../managed/validation'
import type { PeerRpc } from '../p2p/rpc'
import { PeerHelperError } from '../p2p/wire'

/** Where the registry lives and which spelling its paths are validated in. */
export interface CoreRootsLocation {
  readonly filePath: string
  readonly nativeDshHome: string
  readonly pathStyle: ManagedPathStyle
}

/** The registry operations the shell performs, wherever they are served. */
export interface CoreRootsPort {
  inspect(location: CoreRootsLocation, signal?: AbortSignal): Promise<ManagedRootRegistry>
  commit(
    location: CoreRootsLocation,
    registry: ManagedRootRegistry,
    signal?: AbortSignal
  ): Promise<ManagedRootRegistry>
}

const CALL_BUDGET_MS = 30_000

function budget(signal?: AbortSignal): AbortSignal {
  return signal ?? AbortSignal.timeout(CALL_BUDGET_MS)
}

/** Projects one core answer through the validator the shell used while it owned the file. */
function registryOf(value: unknown, location: CoreRootsLocation): ManagedRootRegistry {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new PeerHelperError('p2p.invalid_payload')
  if (!('registry' in value)) throw new PeerHelperError('p2p.invalid_payload')
  return parseManagedRootRegistryValue(
    (value as { registry: unknown }).registry,
    location.pathStyle,
    location.nativeDshHome
  )
}

/** Calls the core.roots_* methods of a live dshkerd over its private channel. */
export class CoreRoots implements CoreRootsPort {
  readonly #rpc: Pick<PeerRpc, 'call'>

  constructor(rpc: Pick<PeerRpc, 'call'>) {
    this.#rpc = rpc
  }

  async inspect(location: CoreRootsLocation, signal?: AbortSignal): Promise<ManagedRootRegistry> {
    return registryOf(
      await this.#rpc.call(
        'core.roots_inspect',
        { filePath: location.filePath, nativeDshHome: location.nativeDshHome },
        budget(signal)
      ),
      location
    )
  }

  async commit(
    location: CoreRootsLocation,
    registry: ManagedRootRegistry,
    signal?: AbortSignal
  ): Promise<ManagedRootRegistry> {
    return registryOf(
      await this.#rpc.call(
        'core.roots_commit',
        {
          filePath: location.filePath,
          nativeDshHome: location.nativeDshHome,
          registry
        },
        budget(signal)
      ),
      location
    )
  }
}
