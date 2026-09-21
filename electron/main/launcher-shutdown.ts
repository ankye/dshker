import type { LauncherHarnessService } from './managed/launcher-harness-service'
import type { PeerManagement } from './p2p/management'
import type { RemoteConnectionService } from './remote'

export interface LauncherShutdownOwners {
  readonly launcherHarnessService: Pick<LauncherHarnessService, 'shutdown'>
  readonly remoteConnectionService: Pick<RemoteConnectionService, 'shutdown'>
  readonly remotePeerBroker: Readonly<{ shutdown(): Promise<void> }>
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
    Promise.resolve().then(() => owners.remotePeerBroker.shutdown())
  ])
  // The attached desktop must stop issuing core calls before it hands the
  // headless owner back. Keeping this after the connection phase also makes
  // Cmd+Q deterministic when a peer reconnect is in flight.
  const coreResults = owners.coreSupervisor
    ? await Promise.allSettled([Promise.resolve().then(() => owners.coreSupervisor!.close())])
    : []
  // Close incoming admission and forwarding before stopping the actual DSH child.
  const runtimeResults = await Promise.allSettled([
    Promise.resolve().then(() => owners.launcherHarnessService.shutdown())
  ])
  const errors = [...connectionResults, ...coreResults, ...runtimeResults]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason as unknown)
  if (errors.length) throw new LauncherShutdownError(errors)
}

/** The application-level actions the quit sequence drives, injected for testing. */
export interface LauncherQuitHost {
  /** Releases the minimise-to-tray close interception; see `beginForceQuit`. */
  readonly beginForceQuit: () => void
  /** Removes the tray icon. */
  readonly destroyTray: () => void
  /** Requests a normal quit. */
  readonly quit: () => void
  /** Ends the process without a further quit request. */
  readonly exit: (code: number) => void
  /** Reports a cleanup failure; the product has no surface left at this point. */
  readonly reportFailure: (error: unknown) => void
}

/**
 * Runs the one quit sequence every exit path shares.
 *
 * Ordering is the whole point of this function, because two orderings produced an
 * application that could not be quit at all:
 *
 * The interception is released *first*. A quit reaches here from Cmd+Q, the
 * application menu, the Dock, the tray or a termination signal, and only the tray
 * used to clear the flag. Every other path ran this cleanup and was then
 * cancelled when the window hid itself instead of closing, leaving a process with
 * no window, no tray icon, a stopped core and the single-instance lock still
 * held — invisible, unquittable, and blocking the next launch.
 *
 * The tray is destroyed *last*, and only when the quit is certain to proceed. It
 * used to be destroyed up front, so a cleanup failure removed the user's only
 * remaining way to ask again.
 *
 * A cleanup failure still ends the process. The user asked to leave and every
 * owner was already attempted; the alternative is the same hidden unquittable
 * process, which is worse than an unclean exit.
 */
export function createLauncherQuitSequence(
  owners: LauncherShutdownOwners,
  host: LauncherQuitHost
): { readonly run: () => Promise<void>; readonly isComplete: () => boolean } {
  let running = false
  let complete = false
  return {
    isComplete: () => complete,
    run: async () => {
      if (running) return
      running = true
      host.beginForceQuit()
      try {
        await shutdownLauncherOwners(owners)
      } catch (error) {
        host.reportFailure(error)
        host.destroyTray()
        host.exit(1)
        return
      }
      host.destroyTray()
      complete = true
      host.quit()
    }
  }
}
