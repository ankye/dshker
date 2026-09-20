import { describe, expect, it, vi } from 'vitest'
import { CoreAutoConnect } from './auto-connect'
import { PeerHelperError } from './wire'

/**
 * The shell's half of reconnection after it moved into the core.
 *
 * This file used to test a full backoff implementation that lived here. That
 * implementation is gone: the schedule, the terminal-refusal set and the
 * clear-on-reauthorization rule are the core's (`internal/autoconnect`), which is
 * what lets a headless host recover a dropped connection with no desktop session.
 * Those behaviors are covered by that package's own tests. What remains to test
 * here is that the shell *forwards* and does not decide.
 */
describe('shell reconnection client', () => {
  it('forwards each operation to its core method with the service envelope', async () => {
    const call = vi.fn(async (_method: string, _payload: unknown, _signal: AbortSignal) => ({}))
    const client = new CoreAutoConnect({ call })

    await client.reconcile('svc-1')
    await client.retryNow('svc-1')
    await client.clearRefusals('svc-1')

    expect(call.mock.calls.map((entry) => entry[0])).toEqual([
      'peer.autoconnect_reconcile',
      'peer.autoconnect_retry_now',
      'peer.autoconnect_clear_refusals'
    ])
    for (const entry of call.mock.calls) {
      expect(entry[1]).toEqual({ serviceId: 'svc-1', data: {} })
    }
  })

  /**
   * These calls run from stage transitions and catalog revisions, not from user
   * operations. A core with no session for the service yet answers
   * `p2p.service_unconfigured`, and turning that into an unhandled rejection would
   * make a routine sweep look like a failure.
   */
  it('swallows a refusal instead of failing a background sweep', async () => {
    const call = vi.fn(async () => {
      throw new PeerHelperError('p2p.service_unconfigured')
    })
    const client = new CoreAutoConnect({ call })

    await expect(client.reconcile('svc-1')).resolves.toBeUndefined()
    await expect(client.retryNow('svc-1')).resolves.toBeUndefined()
    await expect(client.clearRefusals('svc-1')).resolves.toBeUndefined()
    expect(call).toHaveBeenCalledTimes(3)
  })

  it('passes a caller signal through instead of imposing its own budget', async () => {
    const call = vi.fn(async (_method: string, _payload: unknown, _signal: AbortSignal) => ({}))
    const client = new CoreAutoConnect({ call })
    const controller = new AbortController()

    await client.reconcile('svc-1', controller.signal)

    expect(call.mock.calls[0]?.[2]).toBe(controller.signal)
  })

  /**
   * The point of the move: no delay table, no refusal classification and no timer
   * may reappear in the shell. A second copy is how one behavior became two
   * implementations, so this asserts against the source itself rather than trusting
   * that nobody adds one back.
   */
  it('keeps no schedule or refusal policy of its own', async () => {
    const { readFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const source = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'auto-connect.ts'),
      'utf8'
    )
    for (const forbidden of [
      'setTimeout',
      'BACKOFF',
      'p2p.pair_unauthorized',
      'p2p.network_revoked',
      'TERMINAL'
    ]) {
      expect(source, `the shell must not reimplement ${forbidden}`).not.toContain(forbidden)
    }
  })
})
