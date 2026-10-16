import type { PeerAccounts } from './accounts'
import type { P2PSelectionStore } from './selection-preferences'
import { PeerHelperError } from './wire'

export type CertificateRecoveryAccounts = Pick<
  PeerAccounts,
  'hasSession' | 'sessionToken' | 'currentUser' | 'refreshDirectory'
>

export interface VerifiedCertificateRecoveryScope {
  readonly networkId: string
  assertCurrent(): void
  recheck(): Promise<void>
}

/** Main-only admission of one authenticated user's explicit legacy recovery scope. */
export class PeerCertificateRecoveryScope {
  readonly #changes = new Map<string, object>()

  constructor(private readonly selection: Pick<P2PSelectionStore, 'remembered'>) {}

  selectionChanged(serviceId: string): void {
    this.#changes.set(serviceId, {})
  }

  async resolve(
    serviceId: string,
    deviceId: string,
    accounts: CertificateRecoveryAccounts,
    token: string,
    signal: AbortSignal,
    assertLifecycle: () => void
  ): Promise<VerifiedCertificateRecoveryScope> {
    const version = this.#changes.get(serviceId)
    const assertCurrent = () => {
      assertLifecycle()
      if (
        signal.aborted ||
        !accounts.hasSession(serviceId) ||
        accounts.sessionToken(serviceId) !== token ||
        this.#changes.get(serviceId) !== version
      )
        throw new PeerHelperError('p2p.request_cancelled')
    }
    assertCurrent()
    const user = await accounts.currentUser(serviceId, signal)
    assertCurrent()
    const networkId = await this.#remembered(serviceId, user.userId)
    assertCurrent()
    if (networkId === undefined) throw new PeerHelperError('p2p.certificate_recovery_required')
    const directory = await accounts.refreshDirectory(serviceId, signal)
    assertCurrent()
    if (directory.known === false) throw new PeerHelperError('p2p.certificate_sync_failed')
    if (directory.known !== true || !Array.isArray(directory.networks))
      throw new PeerHelperError('p2p.invalid_server_response')
    const selected = directory.networks.filter((network) => network.networkId === networkId)
    if (selected.length === 0) throw new PeerHelperError('p2p.certificate_recovery_forbidden')
    if (selected.length !== 1) throw new PeerHelperError('p2p.invalid_server_response')
    const network = selected[0]
    if (!Array.isArray(network.devices)) throw new PeerHelperError('p2p.invalid_server_response')
    if (
      network.userId !== user.userId ||
      !network.devices.some((device) => device.deviceId === deviceId)
    )
      throw new PeerHelperError('p2p.certificate_recovery_forbidden')
    return {
      networkId,
      assertCurrent,
      recheck: async () => {
        assertCurrent()
        const selected = await this.#remembered(serviceId, user.userId)
        assertCurrent()
        if (selected !== networkId) throw new PeerHelperError('p2p.request_cancelled')
      }
    }
  }

  async #remembered(serviceId: string, userId: string): Promise<string | undefined> {
    try {
      return await this.selection.remembered(serviceId, userId)
    } catch (error) {
      if (error instanceof PeerHelperError) throw error
      throw new PeerHelperError('p2p.certificate_sync_failed')
    }
  }
}
