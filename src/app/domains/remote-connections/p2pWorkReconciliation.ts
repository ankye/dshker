import { reactive } from 'vue'
import { p2pConnections, type P2PConnectionsDomain } from './p2pConnections'

/**
 * What a user needs to know about work that was in flight when a remote
 * workbench became unreachable.
 *
 * `connection_lost` and `work_unknown` are deliberately different. Losing the
 * transport says nothing about whether the remote DSH kept running a task, so
 * the outcome must be re-read from the remote side rather than inferred, and it
 * must never be replayed automatically.
 */
export type P2PWorkVerdict =
  | { kind: 'none' }
  | { kind: 'connected' }
  | { kind: 'connection_lost' }
  | { kind: 'work_unknown' }
  | { kind: 'runtime_replaced' }

export interface P2PWorkRecord {
  /** The attempt that was live when work was last observed. */
  attemptId: string
  generation: number
  runtimeGeneration: number
  /** True once the user reported starting work on this attempt. */
  workStarted: boolean
  /** Set when the user explicitly confirmed the remote outcome. */
  reconciled: boolean
}

/**
 * Tracks in-flight remote work across disconnects.
 *
 * This layer never starts, cancels or resubmits anything: it only decides what
 * the user must be told, so a lost connection cannot be mistaken for a stopped
 * task and a task outcome is never fabricated.
 */
export class P2PWorkReconciliationDomain {
  readonly #records = reactive<Record<string, P2PWorkRecord>>({})
  constructor(private readonly connections: P2PConnectionsDomain) {}

  #key(serviceId: string, pairId: string): string {
    return `${serviceId}:${pairId}`
  }

  record(serviceId: string, pairId: string): P2PWorkRecord | undefined {
    return this.#records[this.#key(serviceId, pairId)]
  }

  /**
   * Notes that the user began work on the currently live attempt.
   *
   * Requires a ready connection: work cannot start on an attempt that never
   * reached a usable workbench.
   */
  noteWorkStarted(serviceId: string, pairId: string): boolean {
    const live = this.connections.find(serviceId, pairId)
    if (!live || live.stage !== 'ready') return false
    this.#records[this.#key(serviceId, pairId)] = {
      attemptId: live.attemptId,
      generation: live.generation,
      runtimeGeneration: live.runtimeGeneration,
      workStarted: true,
      reconciled: false
    }
    return true
  }

  /**
   * Records that the user checked the remote outcome themselves.
   *
   * Only an explicit confirmation clears the warning; reconnecting does not.
   */
  markReconciled(serviceId: string, pairId: string): void {
    const record = this.#records[this.#key(serviceId, pairId)]
    if (record) record.reconciled = true
  }

  /** Drops tracking, for example after the pair is revoked. */
  forget(serviceId: string, pairId: string): void {
    delete this.#records[this.#key(serviceId, pairId)]
  }

  /**
   * Decides what to tell the user about one paired computer.
   *
   * A reconnect that produced a different runtime generation is reported as
   * `runtime_replaced`, because the previous workbench is definitively gone and
   * any earlier task belongs to a runtime that no longer exists.
   */
  verdict(serviceId: string, pairId: string): P2PWorkVerdict {
    const record = this.#records[this.#key(serviceId, pairId)]
    const live = this.connections.find(serviceId, pairId)
    if (!record || !record.workStarted || record.reconciled) {
      if (live?.stage === 'ready') return { kind: 'connected' }
      return { kind: 'none' }
    }
    if (live?.stage === 'ready') {
      // Same runtime: the workbench survived and can be inspected directly.
      if (
        live.attemptId === record.attemptId &&
        live.runtimeGeneration === record.runtimeGeneration
      )
        return { kind: 'connected' }
      return { kind: 'runtime_replaced' }
    }
    if (live === undefined || live.stage === 'disconnected') return { kind: 'connection_lost' }
    if (live.stage === 'failed') return { kind: 'work_unknown' }
    // Still negotiating a new attempt: the earlier outcome remains unknown.
    return { kind: 'work_unknown' }
  }

  /** True when the user must check the remote side before trusting any result. */
  needsAttention(serviceId: string, pairId: string): boolean {
    const kind = this.verdict(serviceId, pairId).kind
    return kind === 'connection_lost' || kind === 'work_unknown' || kind === 'runtime_replaced'
  }
}

export const p2pWorkReconciliation = new P2PWorkReconciliationDomain(p2pConnections)
