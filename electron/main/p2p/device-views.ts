import type { P2PDirectoryView } from '../../../src/shared/p2p-management'
import type { PeerDirectory } from './account-records'
import type { PeerAccounts } from './accounts'
import { projectPeerDirectory } from './management-projection'

/**
 * Runs one operation as the signed-in account of one service.
 *
 * This is `PeerManagement`'s own admission path (activate the service, adopt the
 * persisted login), passed in rather than reached for, so these reads cannot
 * accidentally bypass it.
 */
export type AccountOperation = <T>(
  serviceId: string,
  signal: AbortSignal,
  operation: (accounts: PeerAccounts, signal: AbortSignal) => Promise<T>
) => Promise<T>

/**
 * The device directories the renderer reads.
 *
 * They live together because they answer one question — which devices does the
 * signed-in account see, and which of them is this machine? — and because the
 * local marker has one source: the credential main registered, never the reply.
 * The core owns the answers; nothing here caches a second copy.
 */
export class PeerDeviceViews {
  constructor(
    private readonly asAccount: AccountOperation,
    /** This machine's registered device id, empty when the service has none. */
    private readonly registeredDeviceId: (serviceId: string) => Promise<string>
  ) {}

  /**
   * The core's cached directory, already projected for the renderer.
   *
   * The projection happens here rather than at the IPC boundary because `isLocal`
   * comes from main's own registered credential — the one part of the view the
   * core cannot supply — while every row was already validated by
   * `PeerAccounts` before it got this far.
   */
  directory(serviceId: string, signal: AbortSignal): Promise<P2PDirectoryView> {
    return this.#view(serviceId, signal, (accounts, active) =>
      accounts.directory(serviceId, active)
    )
  }

  /** The core's directory after one more coordinator read, projected the same way. */
  refreshDirectory(serviceId: string, signal: AbortSignal): Promise<P2PDirectoryView> {
    return this.#view(serviceId, signal, (accounts, active) =>
      accounts.refreshDirectory(serviceId, active)
    )
  }

  async #view(
    serviceId: string,
    signal: AbortSignal,
    read: (accounts: PeerAccounts, signal: AbortSignal) => Promise<PeerDirectory>
  ): Promise<P2PDirectoryView> {
    const directory = await this.asAccount(serviceId, signal, read)
    return projectPeerDirectory(directory, await this.registeredDeviceId(serviceId))
  }
}
