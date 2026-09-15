import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { P2PCatalogView, P2PComputerView, P2PConnectionView } from '@/shared/p2p-management'
import { p2pConnections, p2pManagement } from '@/app/domains/remote-connections'
import { resetRuntimeBrowserForTests, runtimeBrowser } from '../runtimeBrowserState'

const serviceId = 'a'.repeat(12)
const connectionId = 'c'.repeat(12)
const pairId = '1'.repeat(12)

function computer(overrides: Partial<P2PComputerView> = {}): P2PComputerView {
  return {
    connectionId,
    serviceId,
    displayName: 'Studio',
    pairId,
    networkId: '2'.repeat(12),
    localDeviceId: '3'.repeat(12),
    remoteDeviceId: '4'.repeat(12),
    userId: '5'.repeat(12),
    localPublicKey: 'local-key',
    remotePublicKey: 'remote-key',
    pairRevision: 1,
    pairState: 'active',
    ...overrides
  }
}

function catalog(entries: P2PComputerView[]): P2PCatalogView {
  return {
    revision: 'b'.repeat(64),
    catalogId: 'd'.repeat(12),
    services: [],
    computers: entries,
    forgottenServiceIds: []
  }
}

function peer(overrides: Partial<P2PConnectionView> = {}): P2PConnectionView {
  return {
    serviceId,
    pairId,
    attemptId: '6'.repeat(12),
    generation: 1,
    stage: 'ready',
    error: '',
    path: { localType: 'host', remoteType: 'host', protocol: 'udp' },
    runtimeGeneration: 1,
    ...overrides
  }
}

function peerTab() {
  return runtimeBrowser.tabs.value.find((tab) => tab.id === `peer:${connectionId}`)
}

/**
 * Points the state at a ready peer whose entry main will hand over.
 *
 * `ready` is only a stage; the address arrives from main, so a test about a
 * loadable peer has to stand in for that answer as well.
 */
async function readyPeerWithEntry(
  entry: { url: string; partition: string } | undefined,
  overrides: Partial<P2PConnectionView> = {}
): Promise<void> {
  const view = peer(overrides)
  vi.spyOn(p2pConnections, 'isReady').mockReturnValue(true)
  vi.spyOn(p2pConnections, 'find').mockReturnValue(view)
  const spy = vi.spyOn(p2pConnections, 'entry')
  if (entry) spy.mockResolvedValue(entry)
  else spy.mockResolvedValue(undefined)
  p2pConnections.state.peers = [view]
  // The fetch is asynchronous by design, so the tab is only loadable after it.
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

beforeEach(() => {
  p2pManagement.catalog.value = catalog([computer()])
  vi.spyOn(p2pConnections, 'isReady').mockReturnValue(false)
  resetRuntimeBrowserForTests()
  runtimeBrowser.openRemoteTab(`peer:${connectionId}`)
})

afterEach(async () => {
  vi.restoreAllMocks()
  p2pConnections.state.peers = undefined
  p2pManagement.catalog.value = null
  resetRuntimeBrowserForTests()
  await nextTick()
})

describe('paired computer Run tabs', () => {
  it('keeps peer workspaces lazy until explicitly opened', () => {
    resetRuntimeBrowserForTests()
    expect(runtimeBrowser.tabs.value.map((tab) => tab.id)).toEqual(['local'])
    expect(runtimeBrowser.openRemoteTab(`peer:${connectionId}`)).toBe(true)
    expect(runtimeBrowser.tabs.value.map((tab) => tab.id)).toEqual([
      'local',
      `peer:${connectionId}`
    ])
  })

  it('retains one tab per explicitly opened paired computer', () => {
    expect(peerTab()).toMatchObject({ source: 'peer', connectionId, title: 'Studio' })
  })

  it('carries no address while the peer is not connected', () => {
    expect(peerTab()?.url).toBeUndefined()
  })

  it('never carries an address for a revoked pair', async () => {
    vi.spyOn(p2pConnections, 'isReady').mockReturnValue(true)
    p2pManagement.catalog.value = catalog([computer({ pairState: 'revoked' })])
    await nextTick()
    // Revoked keeps its tab so the user sees why, but it must not load.
    expect(peerTab()).toBeDefined()
    expect(peerTab()?.url).toBeUndefined()
  })

  it('keeps the DSH entry point out of tab state even when ready', () => {
    vi.spyOn(p2pConnections, 'isReady').mockReturnValue(true)
    expect(JSON.stringify(peerTab())).not.toMatch(/127\.0\.0\.1|token/i)
  })

  it('reports the pair connection stage, like an SSH tab reports its own', async () => {
    // The peer branch hardcoded status to undefined while the SSH branch carried
    // a real one, so a paired computer's tab could not show whether it was
    // connecting, ready or failed.
    const stages = [
      ['punching', { kind: 'connecting' }],
      ['starting-runtime', { kind: 'connecting' }],
      ['ready', { kind: 'ready' }],
      ['disconnected', { kind: 'disconnected' }]
    ] as const
    for (const [stage, expected] of stages) {
      p2pConnections.state.peers = [peer({ stage })]
      await nextTick()
      expect(peerTab()?.status, stage).toEqual(expected)
    }
    p2pConnections.state.peers = [peer({ stage: 'failed', error: 'p2p.operation_failed' })]
    await nextTick()
    expect(peerTab()?.status).toEqual({ kind: 'failed', code: 'p2p.operation_failed' })
  })

  it('separates an unread connection list from a disconnected pair', async () => {
    p2pConnections.state.peers = undefined
    await nextTick()
    // Never having looked is not evidence that the pair is disconnected.
    expect(peerTab()?.status).toBeUndefined()
    p2pConnections.state.peers = []
    await nextTick()
    expect(peerTab()?.status).toEqual({ kind: 'disconnected' })
  })

  it('reports a revoked pair as disconnected rather than failed', async () => {
    p2pConnections.state.peers = [peer({ stage: 'ready' })]
    p2pManagement.catalog.value = catalog([computer({ pairState: 'revoked' })])
    await nextTick()
    // Losing authorization is not a connection fault.
    expect(peerTab()?.status).toEqual({ kind: 'disconnected' })
    expect(peerTab()?.url).toBeUndefined()
  })

  it('keeps no address in the status even when ready', async () => {
    p2pConnections.state.peers = [peer({ stage: 'ready' })]
    await nextTick()
    expect(peerTab()?.status).toEqual({ kind: 'ready' })
    // A ready SSH status carries a url; the peer entry point must stay in main.
    expect(JSON.stringify(peerTab()?.status)).not.toMatch(/http|127\.0\.0\.1|url/i)
  })

  it('follows a rename without changing tab identity', async () => {
    const before = peerTab()?.id
    p2pManagement.catalog.value = catalog([computer({ displayName: 'Renamed studio' })])
    await nextTick()
    expect(peerTab()?.id).toBe(before)
    expect(peerTab()?.title).toBe('Renamed studio')
  })

  it('removes the tab when the computer leaves the catalog', async () => {
    p2pManagement.catalog.value = catalog([])
    await nextTick()
    expect(peerTab()).toBeUndefined()
  })

  it('falls back to the local tab when the active peer disappears', async () => {
    runtimeBrowser.activeTabId.value = `peer:${connectionId}`
    await nextTick()
    p2pManagement.catalog.value = catalog([])
    await nextTick()
    expect(runtimeBrowser.activeTabId.value).toBe('local')
  })

  it('keeps SSH and local tabs intact alongside peers', () => {
    const ids = runtimeBrowser.tabs.value.map((tab) => tab.id)
    expect(ids).toContain('local')
    expect(ids.filter((id) => id.startsWith('peer:'))).toHaveLength(1)
  })
  // The finding this test exists for: a `ready` peer used to carry no address at
  // all, because nothing ever asked main for the one it holds. The tab showed the
  // empty state with a green indicator — connected, and impossible to open.
  it('loads the workbench main hands over for a ready peer', async () => {
    await readyPeerWithEntry({
      url: 'http://127.0.0.1:41234/?token=unit-test-only',
      partition: 'persist:dshker-peer-unit'
    })

    expect(peerTab()?.url).toBe('http://127.0.0.1:41234/?token=unit-test-only')
    // The guest is isolated per pair, and the partition name comes from main.
    expect(peerTab()?.partition).toBe('persist:dshker-peer-unit')
  })

  it('asks main for the address of the attempt it is rendering', async () => {
    await readyPeerWithEntry(
      { url: 'http://127.0.0.1:41235/?token=unit-test-only', partition: 'persist:dshker-peer-2' },
      { generation: 7 }
    )

    expect(vi.mocked(p2pConnections.entry)).toHaveBeenCalledWith(serviceId, pairId, 7)
  })

  it('keeps the tab empty while main has no address for the peer', async () => {
    await readyPeerWithEntry(undefined)

    expect(peerTab()?.url).toBeUndefined()
    expect(peerTab()?.partition).toBeUndefined()
  })

  it('drops the address once the peer is no longer ready', async () => {
    await readyPeerWithEntry({
      url: 'http://127.0.0.1:41236/?token=unit-test-only',
      partition: 'persist:dshker-peer-3'
    })
    expect(peerTab()?.url).toBeDefined()

    // The attempt failed after the address had been handed over: the tab must not
    // keep pointing a guest at a gateway the session no longer owns.
    vi.mocked(p2pConnections.find).mockReturnValue(peer({ stage: 'failed' }))
    p2pConnections.state.peers = [peer({ stage: 'failed' })]
    await nextTick()
    await Promise.resolve()
    await nextTick()

    expect(peerTab()?.url).toBeUndefined()
  })

  /** Lets the state watcher run and the pending entry answer settle. */
  async function settle(): Promise<void> {
    await nextTick()
    await Promise.resolve()
    await nextTick()
    await Promise.resolve()
  }

  /**
   * A peer can be replaced while main is still answering about the previous
   * attempt, and the answer for the old attempt carries a gateway only that
   * attempt owns. Keeping it would point the guest at a token the session no
   * longer holds; the drop has to leave the current attempt asked about, because
   * the change that replaced the attempt found a question already in flight.
   */
  it('drops an answer for an attempt the peer has already replaced', async () => {
    vi.spyOn(p2pConnections, 'isReady').mockReturnValue(true)
    let current = peer({ generation: 1 })
    vi.spyOn(p2pConnections, 'find').mockImplementation(() => current)
    const answers: ((value: { url: string; partition: string } | undefined) => void)[] = []
    const entry = vi
      .spyOn(p2pConnections, 'entry')
      .mockImplementation(() => new Promise((resolve) => answers.push(resolve)))

    p2pConnections.state.peers = [current]
    await settle()
    expect(entry).toHaveBeenCalledWith(serviceId, pairId, 1)

    current = peer({ generation: 2 })
    p2pConnections.state.peers = [current]
    await settle()
    // One question per attempt: the second stage change must not stack a request.
    expect(entry).toHaveBeenCalledTimes(1)

    answers[0]?.({
      url: 'http://127.0.0.1:41999/?token=superseded',
      partition: 'persist:dshker-peer-stale'
    })
    await settle()
    expect(peerTab()?.url).toBeUndefined()
    expect(peerTab()?.partition).toBeUndefined()
    // The attempt that is actually current is asked about in its place.
    expect(entry).toHaveBeenLastCalledWith(serviceId, pairId, 2)

    answers[1]?.({
      url: 'http://127.0.0.1:42000/?token=current',
      partition: 'persist:dshker-peer-current'
    })
    await settle()
    expect(peerTab()?.url).toBe('http://127.0.0.1:42000/?token=current')
  })

  /**
   * The stage and the catalog arrive from two different reads, so a connection
   * can become ready before the computer that owns it is listed — a catalog read
   * that lands last. Watching only the stage meant that peer never had its
   * address asked for and showed the empty state forever.
   */
  it('asks for the address of a computer that appears after the connection is ready', async () => {
    vi.spyOn(p2pConnections, 'isReady').mockReturnValue(true)
    vi.spyOn(p2pConnections, 'find').mockReturnValue(peer({ generation: 3 }))
    const entry = vi.spyOn(p2pConnections, 'entry').mockResolvedValue({
      url: 'http://127.0.0.1:42001/?token=late-catalog',
      partition: 'persist:dshker-peer-late'
    })

    p2pManagement.catalog.value = catalog([])
    p2pConnections.state.peers = [peer({ generation: 3 })]
    await settle()
    expect(entry).not.toHaveBeenCalled()

    // Nothing changes but the catalog, so the catalog is what has to ask.
    p2pManagement.catalog.value = catalog([computer()])
    await settle()
    expect(entry).toHaveBeenCalledWith(serviceId, pairId, 3)

    // The closed tab is opened again and renders the address that was fetched for
    // it while no tab was mounted.
    expect(runtimeBrowser.openRemoteTab(`peer:${connectionId}`)).toBe(true)
    await settle()
    expect(peerTab()?.url).toBe('http://127.0.0.1:42001/?token=late-catalog')
  })
})
