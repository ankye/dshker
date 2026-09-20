// The main-only view of the core's start-at-boot registration.
//
// The registration itself belongs to the core: it names the core executable and
// uses the platform facility (a launchd agent, a Windows run-key entry). The shell
// does not write it and keeps no copy of its own, so the settings toggle and the
// headless `dshkerd autostart` subcommand are two readers of one state rather than
// two competing mechanisms. Electron's own `setLoginItemSettings` is deliberately
// not used: it would register the *desktop app*, which is a different thing from a
// host that serves with no desktop session.
import type { PeerRpc } from '../p2p/rpc'
import { PeerHelperError } from '../p2p/wire'

/** The shared registration state both surfaces render. */
export interface CoreAutostartState {
  /** Whether the registration is present right now. */
  readonly installed: boolean
  /** The platform facility, for display and diagnostics. */
  readonly mechanism: string
  /** The registration this machine reads, when the platform has a path. */
  readonly path?: string
}

/** The operations the settings control performs, wherever they are served. */
export interface CoreAutostartPort {
  status(signal?: AbortSignal): Promise<CoreAutostartState>
  enable(signal?: AbortSignal): Promise<CoreAutostartState>
  disable(signal?: AbortSignal): Promise<CoreAutostartState>
}

/** A registration change touches the filesystem and a platform tool. */
const CALL_BUDGET_MS = 30_000

function budget(signal?: AbortSignal): AbortSignal {
  return signal ?? AbortSignal.timeout(CALL_BUDGET_MS)
}

/**
 * Reads one answer as a state.
 *
 * `installed` must be a real boolean from the core. Coercing a missing or
 * malformed field to `false` would render a machine that *is* registered as off,
 * and the next click would try to enable something already enabled.
 */
function stateOf(value: unknown): CoreAutostartState {
  if (typeof value !== 'object' || value === null) throw new PeerHelperError('p2p.invalid_payload')
  const record = value as { installed?: unknown; mechanism?: unknown; path?: unknown }
  if (typeof record.installed !== 'boolean' || typeof record.mechanism !== 'string') {
    throw new PeerHelperError('p2p.invalid_payload')
  }
  const path = typeof record.path === 'string' && record.path !== '' ? record.path : undefined
  return { installed: record.installed, mechanism: record.mechanism, path }
}

/** Calls the core.autostart_* methods of a live dshkerd over its private channel. */
export class CoreAutostart implements CoreAutostartPort {
  readonly #rpc: Pick<PeerRpc, 'call'>

  constructor(rpc: Pick<PeerRpc, 'call'>) {
    this.#rpc = rpc
  }

  async status(signal?: AbortSignal): Promise<CoreAutostartState> {
    return stateOf(await this.#rpc.call('core.autostart_status', {}, budget(signal)))
  }

  async enable(signal?: AbortSignal): Promise<CoreAutostartState> {
    return stateOf(await this.#rpc.call('core.autostart_enable', {}, budget(signal)))
  }

  async disable(signal?: AbortSignal): Promise<CoreAutostartState> {
    return stateOf(await this.#rpc.call('core.autostart_disable', {}, budget(signal)))
  }
}
