// The main-only view of the core's managed installation catalog.
//
// The document shape is the one the shell has always written, so routing it
// through the core changes who persists it and nothing about what is persisted:
// same format, same version, same file name. Only Electron main holds one of
// these, and no path or identifier ever reaches the renderer through it.
import { parseManagedInstallationCatalogValue } from '../managed/installation-catalog'
import type { ManagedInstallationCatalog } from '../managed/installation-catalog'
import type { PeerRpc } from '../p2p/rpc'
import { PeerHelperError } from '../p2p/wire'

/** Where the catalog lives. The core accepts exactly this one file name below it. */
export interface CoreInstallCatalogLocation {
  readonly filePath: string
}

/** The catalog operations the shell performs, wherever they are served. */
export interface CoreInstallCatalogPort {
  inspect(
    location: CoreInstallCatalogLocation,
    signal?: AbortSignal
  ): Promise<ManagedInstallationCatalog>
  commit(
    location: CoreInstallCatalogLocation,
    catalog: ManagedInstallationCatalog,
    signal?: AbortSignal
  ): Promise<ManagedInstallationCatalog>
}

const CALL_BUDGET_MS = 30_000

function budget(signal?: AbortSignal): AbortSignal {
  return signal ?? AbortSignal.timeout(CALL_BUDGET_MS)
}

/** Projects one core answer through the validator the shell used while it owned the file. */
function catalogOf(value: unknown): ManagedInstallationCatalog {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new PeerHelperError('p2p.invalid_payload')
  if (!('catalog' in value)) throw new PeerHelperError('p2p.invalid_payload')
  return parseManagedInstallationCatalogValue((value as { catalog: unknown }).catalog)
}

/** Calls the core.install_catalog_* methods of a live dshkerd over its private channel. */
export class CoreInstallCatalog implements CoreInstallCatalogPort {
  readonly #rpc: Pick<PeerRpc, 'call'>

  constructor(rpc: Pick<PeerRpc, 'call'>) {
    this.#rpc = rpc
  }

  async inspect(
    location: CoreInstallCatalogLocation,
    signal?: AbortSignal
  ): Promise<ManagedInstallationCatalog> {
    return catalogOf(
      await this.#rpc.call(
        'core.install_catalog_inspect',
        { filePath: location.filePath },
        budget(signal)
      )
    )
  }

  async commit(
    location: CoreInstallCatalogLocation,
    catalog: ManagedInstallationCatalog,
    signal?: AbortSignal
  ): Promise<ManagedInstallationCatalog> {
    return catalogOf(
      await this.#rpc.call(
        'core.install_catalog_commit',
        { filePath: location.filePath, catalog },
        budget(signal)
      )
    )
  }
}
