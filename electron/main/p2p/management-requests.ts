import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron'
import { PeerHelperError } from './wire'

/** Ids below highWater - WINDOW are refused outright, bounding what must be retained. */
const REPLAY_WINDOW = 256

interface Scope {
  frame: WebFrameMain
  highWater: number
  /** Ids already admitted within the replay window; an id is never admitted twice. */
  seen: Set<number>
  pending: Map<number, AbortController>
}

/** A request belongs to one document, not merely a renderer process or window ID. */
export class PeerManagementRequests {
  readonly #scopes = new WeakMap<WebContents, Scope>()
  readonly #retired = new WeakSet<WebContents>()

  async run<T>(
    event: IpcMainInvokeEvent,
    requestId: number,
    writes: boolean,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const scope = this.#admit(event, requestId)
    if (scope.pending.size >= 16) throw new PeerHelperError('p2p.request_limit')
    const controller = new AbortController()
    scope.pending.set(requestId, controller)
    const timer = setTimeout(
      () => controller.abort(new PeerHelperError('p2p.request_timeout')),
      120_000
    )
    try {
      const result = await operation(controller.signal)
      this.#check(controller, writes)
      return result
    } catch (error) {
      this.#check(controller, writes)
      throw error
    } finally {
      clearTimeout(timer)
      scope.pending.delete(requestId)
    }
  }

  cancel(event: IpcMainInvokeEvent, requestId: number, targetRequestId: number) {
    const scope = this.#admit(event, requestId)
    const target = scope.pending.get(targetRequestId)
    if (!target) throw new PeerHelperError('p2p.request_unavailable')
    target.abort(new PeerHelperError('p2p.request_cancelled'))
    return { accepted: true }
  }

  #check(controller: AbortController, writes: boolean): void {
    if (!controller.signal.aborted) return
    // Cancellation is not transaction rollback. Callers must read the original result.
    if (writes) throw new PeerHelperError('p2p.management_result_unconfirmed')
    throw controller.signal.reason
  }

  /**
   * Admits one request exactly once.
   *
   * The renderer allocates ids from a single monotonic sequence, but concurrent
   * invokes on different channels have no ordering guarantee, so an earlier id
   * legitimately arrives after a later one. Rejecting anything below a high
   * water mark would fail those honest requests, so replay protection tracks
   * the ids actually admitted and refuses only a genuine repeat. The window
   * bounds retention: an id far behind the high water mark is refused rather
   * than remembered forever.
   */
  #admit(event: IpcMainInvokeEvent, requestId: number): Scope {
    const scope = this.#scope(event)
    if (!Number.isSafeInteger(requestId) || requestId <= 0)
      throw new PeerHelperError('p2p.invalid_request')
    if (requestId <= scope.highWater - REPLAY_WINDOW || scope.seen.has(requestId))
      throw new PeerHelperError('p2p.request_replayed')
    scope.seen.add(requestId)
    if (requestId > scope.highWater) scope.highWater = requestId
    for (const id of scope.seen) if (id <= scope.highWater - REPLAY_WINDOW) scope.seen.delete(id)
    return scope
  }

  #scope(event: IpcMainInvokeEvent): Scope {
    if (!event.senderFrame || this.#retired.has(event.sender))
      throw new PeerHelperError('p2p.ipc_invalid_sender')
    const current = this.#scopes.get(event.sender)
    if (current) {
      if (current.frame !== event.senderFrame) throw new PeerHelperError('p2p.ipc_invalid_sender')
      return current
    }
    const scope: Scope = {
      frame: event.senderFrame,
      highWater: 0,
      seen: new Set(),
      pending: new Map()
    }
    const retire = () => {
      for (const pending of scope.pending.values())
        pending.abort(new PeerHelperError('p2p.request_cancelled'))
      if (this.#scopes.get(event.sender) === scope) this.#scopes.delete(event.sender)
      this.#retired.add(event.sender)
      // Do not admit the old document again between navigation start and commit.
      event.sender.once('dom-ready', () => this.#retired.delete(event.sender))
      event.sender.removeListener('did-start-navigation', navigation)
      event.sender.removeListener('render-process-gone', retire)
      event.sender.removeListener('destroyed', retire)
    }
    const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) retire()
    }
    event.sender.on('did-start-navigation', navigation)
    event.sender.once('render-process-gone', retire)
    event.sender.once('destroyed', retire)
    this.#scopes.set(event.sender, scope)
    return scope
  }
}
