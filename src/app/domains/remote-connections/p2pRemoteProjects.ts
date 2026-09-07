import { reactive } from 'vue'
import type { P2PRemoteEntryView, P2PRemoteRootView } from '@/shared/p2p-management'
import { p2pManagement, type P2PManagementDomain } from './p2pManagement'

/** One breadcrumb level, so the user can walk back without rebuilding a path. */
export interface P2PRemoteCrumb {
  ref: string
  name: string
}

export interface P2PRemoteBrowseState {
  roots: P2PRemoteRootView[] | undefined
  selectedRootId: string | undefined
  entries: P2PRemoteEntryView[] | undefined
  total: number
  offset: number
  /** Trail inside the selected root; empty means the root itself. */
  trail: P2PRemoteCrumb[]
  /** The project the user explicitly chose, as an opaque reference. */
  chosen: { ref: string; name: string } | undefined
  loadFailed: string | undefined
}

/** One page size, matching the bounded remote listing. */
export const REMOTE_PAGE_SIZE = 50

/**
 * Remote project browsing for the renderer.
 *
 * Navigation is expressed purely through opaque references issued by the remote
 * computer: this side never builds, parses or joins a path, so it cannot reach
 * anywhere the remote user did not authorize. Selecting a project records only
 * that reference, and opening it still goes through the remote DSH's own
 * permission and approval policy.
 */
export class P2PRemoteProjectsDomain {
  readonly #states = reactive<Record<string, P2PRemoteBrowseState>>({})
  constructor(private readonly management: P2PManagementDomain) {}

  state(serviceId: string, pairId: string): P2PRemoteBrowseState {
    const key = `${serviceId}:${pairId}`
    if (!this.#states[key])
      this.#states[key] = {
        roots: undefined,
        selectedRootId: undefined,
        entries: undefined,
        total: 0,
        offset: 0,
        trail: [],
        chosen: undefined,
        loadFailed: undefined
      }
    return this.#states[key]
  }

  async readRoots(serviceId: string, pairId: string): Promise<void> {
    const state = this.state(serviceId, pairId)
    const result = await this.management.run('remoteRoots', { serviceId, pairId })
    if (result.ok) {
      state.roots = result.data
      state.loadFailed = undefined
      // A root that disappeared must not stay selected.
      if (!result.data.some((root) => root.rootId === state.selectedRootId)) this.#reset(state)
    } else state.loadFailed = result.code
  }

  /** Selecting a root is explicit; the first one is never chosen automatically. */
  async selectRoot(serviceId: string, pairId: string, rootId: string): Promise<void> {
    const state = this.state(serviceId, pairId)
    state.selectedRootId = rootId
    state.trail = []
    state.offset = 0
    state.chosen = undefined
    await this.#load(serviceId, pairId)
  }

  /** Descends into a directory using the reference the remote issued. */
  async enter(serviceId: string, pairId: string, entry: P2PRemoteEntryView): Promise<void> {
    const state = this.state(serviceId, pairId)
    if (!state.selectedRootId || !entry.isDirectory) return
    state.trail = [...state.trail, { ref: entry.ref, name: entry.name }]
    state.offset = 0
    await this.#load(serviceId, pairId)
  }

  /** Walks back to an earlier level, or to the root when depth is 0. */
  async ascend(serviceId: string, pairId: string, depth: number): Promise<void> {
    const state = this.state(serviceId, pairId)
    if (!state.selectedRootId || depth < 0 || depth > state.trail.length) return
    state.trail = state.trail.slice(0, depth)
    state.offset = 0
    await this.#load(serviceId, pairId)
  }

  async page(serviceId: string, pairId: string, offset: number): Promise<void> {
    const state = this.state(serviceId, pairId)
    if (offset < 0 || offset >= Math.max(state.total, 1)) return
    state.offset = offset
    await this.#load(serviceId, pairId)
  }

  /** Records an explicit project choice as an opaque reference. */
  choose(serviceId: string, pairId: string, entry: P2PRemoteEntryView): void {
    if (!entry.isProject) return
    this.state(serviceId, pairId).chosen = { ref: entry.ref, name: entry.name }
  }

  clearChoice(serviceId: string, pairId: string): void {
    this.state(serviceId, pairId).chosen = undefined
  }

  /** Drops browsing state when authority is lost, so no stale reference remains. */
  invalidate(serviceId: string, pairId: string): void {
    this.#reset(this.state(serviceId, pairId))
    this.state(serviceId, pairId).roots = undefined
  }

  async #load(serviceId: string, pairId: string): Promise<void> {
    const state = this.state(serviceId, pairId)
    const rootId = state.selectedRootId
    if (!rootId) return
    const ref = state.trail.at(-1)?.ref ?? ''
    const result = await this.management.run('remoteDirectory', {
      serviceId,
      pairId,
      rootId,
      ref,
      offset: state.offset,
      limit: REMOTE_PAGE_SIZE
    })
    if (result.ok) {
      state.entries = result.data.entries
      state.total = result.data.total
      state.loadFailed = undefined
      return
    }
    // Distinct outcomes stay distinct: a forbidden path is not an empty directory.
    state.entries = undefined
    state.loadFailed = result.code
  }

  #reset(state: P2PRemoteBrowseState): void {
    state.selectedRootId = undefined
    state.entries = undefined
    state.total = 0
    state.offset = 0
    state.trail = []
    state.chosen = undefined
  }
}

export const p2pRemoteProjects = new P2PRemoteProjectsDomain(p2pManagement)
