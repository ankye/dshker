import { describe, expect, it, vi } from 'vitest'
import type { P2PManagementApi, P2PRemoteEntryView } from '@/shared/p2p-management'
import { P2PManagementDomain } from './p2pManagement'
import { P2PRemoteProjectsDomain, REMOTE_PAGE_SIZE } from './p2pRemoteProjects'

const serviceId = 'service-a'
const pairId = 'pair-a'
const rootId = 'root-a'
const roots = [
  { rootId, name: 'Work', path: '/Users/remote/work' },
  { rootId: 'root-b', name: 'Games', path: '/Users/remote/games' }
]
const dir = (ref: string, name: string): P2PRemoteEntryView => ({
  ref,
  name,
  isDirectory: true,
  isProject: false
})
const project = (ref: string, name: string): P2PRemoteEntryView => ({
  ref,
  name,
  isDirectory: true,
  isProject: true
})

function setup(entries = [dir('a1', 'alpha'), project('p1', 'my-game')], total = 2) {
  const api = {
    remoteRoots: vi
      .fn<P2PManagementApi['remoteRoots']>()
      .mockResolvedValue({ ok: true, data: roots }),
    remoteDirectory: vi
      .fn<P2PManagementApi['remoteDirectory']>()
      .mockResolvedValue({ ok: true, data: { entries, total } })
  }
  const management = new P2PManagementDomain(() => api as unknown as P2PManagementApi)
  return { api, projects: new P2PRemoteProjectsDomain(management) }
}

describe('renderer remote project browsing', () => {
  it('does not select a root automatically', async () => {
    const { api, projects } = setup()
    await projects.readRoots(serviceId, pairId)
    expect(projects.state(serviceId, pairId).selectedRootId).toBeUndefined()
    expect(api.remoteDirectory).not.toHaveBeenCalled()
  })

  it('lists the root itself with an empty reference', async () => {
    const { api, projects } = setup()
    await projects.selectRoot(serviceId, pairId, rootId)
    expect(api.remoteDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ rootId, ref: '', offset: 0, limit: REMOTE_PAGE_SIZE })
    )
  })

  it('navigates using only references issued by the remote computer', async () => {
    const { api, projects } = setup()
    await projects.selectRoot(serviceId, pairId, rootId)
    await projects.enter(serviceId, pairId, dir('a1', 'alpha'))
    expect(api.remoteDirectory).toHaveBeenLastCalledWith(expect.objectContaining({ ref: 'a1' }))
    // No path was ever constructed or sent.
    for (const call of api.remoteDirectory.mock.calls)
      expect(JSON.stringify(call[0])).not.toMatch(/\/Users|\\\\|\.\./)
  })

  it('does not descend into a non-directory entry', async () => {
    const { api, projects } = setup()
    await projects.selectRoot(serviceId, pairId, rootId)
    api.remoteDirectory.mockClear()
    await projects.enter(serviceId, pairId, { ...dir('x', 'file'), isDirectory: false })
    expect(api.remoteDirectory).not.toHaveBeenCalled()
  })

  it('walks back to an earlier level and to the root', async () => {
    const { api, projects } = setup()
    await projects.selectRoot(serviceId, pairId, rootId)
    await projects.enter(serviceId, pairId, dir('a1', 'alpha'))
    await projects.enter(serviceId, pairId, dir('a2', 'beta'))
    expect(projects.state(serviceId, pairId).trail).toHaveLength(2)
    await projects.ascend(serviceId, pairId, 1)
    expect(api.remoteDirectory).toHaveBeenLastCalledWith(expect.objectContaining({ ref: 'a1' }))
    await projects.ascend(serviceId, pairId, 0)
    expect(api.remoteDirectory).toHaveBeenLastCalledWith(expect.objectContaining({ ref: '' }))
  })

  it('reports the real total and pages without guessing', async () => {
    const { api, projects } = setup([dir('a1', 'alpha')], 120)
    await projects.selectRoot(serviceId, pairId, rootId)
    expect(projects.state(serviceId, pairId).total).toBe(120)
    await projects.page(serviceId, pairId, REMOTE_PAGE_SIZE)
    expect(api.remoteDirectory).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: REMOTE_PAGE_SIZE })
    )
  })

  it('ignores a page request beyond the known total', async () => {
    const { api, projects } = setup([dir('a1', 'alpha')], 2)
    await projects.selectRoot(serviceId, pairId, rootId)
    api.remoteDirectory.mockClear()
    await projects.page(serviceId, pairId, 999)
    expect(api.remoteDirectory).not.toHaveBeenCalled()
  })

  it('keeps a forbidden path distinct from an empty directory', async () => {
    const { api, projects } = setup()
    api.remoteDirectory.mockResolvedValue({
      ok: false,
      code: 'p2p.remote_path_forbidden',
      message: 'denied'
    })
    await projects.selectRoot(serviceId, pairId, rootId)
    const state = projects.state(serviceId, pairId)
    expect(state.entries).toBeUndefined()
    expect(state.loadFailed).toBe('p2p.remote_path_forbidden')
  })

  it('represents a genuinely empty directory as an empty list', async () => {
    const { projects } = setup([], 0)
    await projects.selectRoot(serviceId, pairId, rootId)
    const state = projects.state(serviceId, pairId)
    expect(state.entries).toEqual([])
    expect(state.loadFailed).toBeUndefined()
  })

  it('records a project choice as an opaque reference only', async () => {
    const { projects } = setup()
    await projects.selectRoot(serviceId, pairId, rootId)
    projects.choose(serviceId, pairId, project('p1', 'my-game'))
    expect(projects.state(serviceId, pairId).chosen).toEqual({ ref: 'p1', name: 'my-game' })
  })

  it('refuses to choose a directory that is not a project', async () => {
    const { projects } = setup()
    projects.choose(serviceId, pairId, dir('a1', 'alpha'))
    expect(projects.state(serviceId, pairId).chosen).toBeUndefined()
  })

  it('clears the selection when the authorized root disappears', async () => {
    const { api, projects } = setup()
    await projects.selectRoot(serviceId, pairId, rootId)
    projects.choose(serviceId, pairId, project('p1', 'my-game'))
    api.remoteRoots.mockResolvedValue({ ok: true, data: [roots[1]!] })
    await projects.readRoots(serviceId, pairId)
    const state = projects.state(serviceId, pairId)
    expect(state.selectedRootId).toBeUndefined()
    expect(state.chosen).toBeUndefined()
  })

  it('drops every reference when authority is invalidated', async () => {
    const { projects } = setup()
    await projects.selectRoot(serviceId, pairId, rootId)
    projects.choose(serviceId, pairId, project('p1', 'my-game'))
    projects.invalidate(serviceId, pairId)
    const state = projects.state(serviceId, pairId)
    expect(state.chosen).toBeUndefined()
    expect(state.entries).toBeUndefined()
    expect(state.roots).toBeUndefined()
  })

  it('keeps two computers independent', async () => {
    const { projects } = setup()
    await projects.selectRoot(serviceId, pairId, rootId)
    projects.choose(serviceId, pairId, project('p1', 'my-game'))
    expect(projects.state(serviceId, 'pair-b').chosen).toBeUndefined()
  })
})
