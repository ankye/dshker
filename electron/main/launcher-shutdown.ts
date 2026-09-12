import type { LauncherHarnessService } from './managed/launcher-harness-service'
import type { PeerManagement } from './p2p/management'
import type { RemoteConnectionService, RemotePeerBroker } from './remote'

export interface LauncherShutdownOwners {
  readonly launcherHarnessService: Pick<LauncherHarnessService, 'shutdown'>
  readonly remoteConnectionService: Pick<RemoteConnectionService, 'shutdown'>
  readonly remotePeerBroker: Pick<RemotePeerBroker, 'shutdown'>
  readonly peerManagement: Pick<PeerManagement, 'close'>
  /** Present once the headless core is running; terminated with the shell. */
  readonly coreSupervisor?: { close(): Promise<void> }
}

class LauncherShutdownError extends Error {
  constructor(readonly errors: readonly unknown[]) {
    super('launcher.shutdown_failed')
    this.name = 'LauncherShutdownError'
  }
}

/** Attempt every owned cleanup, but do not report success if any owner failed. */
export async function shutdownLauncherOwners(owners: LauncherShutdownOwners): Promise<void> {
  const connectionResults = await Promise.allSettled([
    Promise.resolve().then(() => owners.peerManagement.close()),
    Promise.resolve().then(() => owners.remoteConnectionService.shutdown()),
    Promise.resolve().then(() => owners.remotePeerBroker.shutdown()),
    ...(owners.coreSupervisor ? [Promise.resolve().then(() => owners.coreSupervisor!.close())] : [])
  ])
  // Close incoming admission and forwarding before stopping the actual DSH child.
  const runtimeResults = await Promise.allSettled([
    Promise.resolve().then(() => owners.launcherHarnessService.shutdown())
  ])
  const errors = [...connectionResults, ...runtimeResults]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason as unknown)
  if (errors.length) throw new LauncherShutdownError(errors)
}
