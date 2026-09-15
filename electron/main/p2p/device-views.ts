import type { P2PDirectoryView } from '../../../src/shared/p2p-management'
import type { PeerDirectory, PeerNetworkDevice } from './account-records'
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
   * Reads a network's device directory together with the local device id.
   *
   * Both come from one owner call so the IPC layer never has to combine two
   * operations, which would make a single read look like two to any caller
   * counting dispatches.
   */
  async networkDevices(
    serviceId: string,
    networkId: string,
    signal: AbortSignal
  ): Promise<{ devices: PeerNetworkDevice[]; localDeviceId: string }> {
    const devices = await this.asAccount(serviceId, signal, (accounts, active) =>
      accounts.listNetworkDevices(serviceId, networkId, active)
    )
    return { devices, localDeviceId: await this.registeredDeviceId(serviceId) }
  }

  /**
   * The devices the signed-in account is bound to, plus this machine's own id.
   *
   * The list is what decides whether this machine belongs to the account signed in
   * here: a device id can be bound to several accounts, so a locally stored
   * "account this credential was issued for" cannot answer it, and the coordinator
   * is the only side that knows.
   *
   * This one read asks the core to read the coordinator rather than answering from
   * the snapshot it holds, because its answer is a list with no way to say "not
   * read yet", and an empty list is read as the positive claim "this machine is
   * not bound to this account" — which is how a legitimately bound machine gets
   * reported as a foreign one. A refusal leaves the caller's list unread, which is
   * the honest answer. The two new directory operations expose the snapshot
   * including its `known` flag for every reader that can render "not read yet".
   */
  async accountDevices(
    serviceId: string,
    signal: AbortSignal
  ): Promise<{ devices: PeerNetworkDevice[]; localDeviceId: string }> {
    const devices = await this.asAccount(serviceId, signal, (accounts, active) =>
      accounts.refreshDirectory(serviceId, active)
    )
    return { devices: devices.devices, localDeviceId: await this.registeredDeviceId(serviceId) }
  }

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
