import { describe, expect, it, vi } from 'vitest'
import { PeerRemoteProjects, MAX_REMOTE_ENTRIES } from './remote-projects'

const serviceId = 'a'.repeat(64)
const pairId = '1'.repeat(32)
const rootId = 'root-a'
const signal = () => AbortSignal.timeout(5000)

const root = { rootId, name: 'Work', path: '/Users/remote/work' }
const entry = (ref: string, name: string, isProject = false) => ({
  ref,
  name,
  isDirectory: true,
  isProject
})

function fixture(authorized = true) {
  const call = vi.fn<(method: string, payload: unknown, signal: AbortSignal) => Promise<unknown>>()
  const authorize = vi.fn(async () => {
    if (!authorized) throw Object.assign(new Error('denied'), { code: 'p2p.pair_not_found' })
  })
  return { call, authorize, projects: new PeerRemoteProjects({ call }, authorize) }
}

describe('main-owned remote projects', () => {
  it('authorizes the pair before any remote request is dispatched', async () => {
    const f = fixture(false)
    await expect(f.projects.roots(serviceId, pairId, signal())).rejects.toThrow()
    expect(f.call).not.toHaveBeenCalled()
  })

  it('reads the roots the remote user authorized', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce({ roots: [root] })
    expect(await f.projects.roots(serviceId, pairId, signal())).toEqual([root])
  })

  it('never builds a reference from a path, forwarding only opaque values', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce({ entries: [entry('abc123', 'alpha')], total: 1 })
    await f.projects.directory(serviceId, pairId, rootId, 'abc123', 0, 50, signal())
    const payload = f.call.mock.calls[0]?.[1] as { data: { ref: string } }
    expect(payload.data.ref).toBe('abc123')
  })

  it('refuses a reference that is not an opaque token', async () => {
    const f = fixture()
    for (const ref of ['/etc/passwd', '../escape', 'C:\\Windows', 'a b'])
      await expect(
        f.projects.directory(serviceId, pairId, rootId, ref, 0, 50, signal())
      ).rejects.toMatchObject({ code: 'p2p.remote_reference_invalid' })
    expect(f.call).not.toHaveBeenCalled()
  })

  it('treats an empty reference as the root itself', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce({ entries: [], total: 0 })
    await f.projects.directory(serviceId, pairId, rootId, '', 0, 50, signal())
    const payload = f.call.mock.calls[0]?.[1] as { data: { ref: string } }
    expect(payload.data.ref).toBe('')
  })

  it('rejects a page larger than the request or the declared total', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce({ entries: [entry('a', 'x'), entry('b', 'y')], total: 5 })
    await expect(
      f.projects.directory(serviceId, pairId, rootId, '', 0, 1, signal())
    ).rejects.toMatchObject({ code: 'p2p.invalid_server_response' })
    f.call.mockResolvedValueOnce({ entries: [entry('a', 'x'), entry('b', 'y')], total: 1 })
    await expect(
      f.projects.directory(serviceId, pairId, rootId, '', 0, 50, signal())
    ).rejects.toMatchObject({ code: 'p2p.invalid_server_response' })
  })

  it('rejects duplicate references in one page', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce({ entries: [entry('same', 'x'), entry('same', 'y')], total: 2 })
    await expect(
      f.projects.directory(serviceId, pairId, rootId, '', 0, 50, signal())
    ).rejects.toMatchObject({ code: 'p2p.invalid_server_response' })
  })

  it('rejects duplicate root ids', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce({ roots: [root, { ...root, name: 'Other' }] })
    await expect(f.projects.roots(serviceId, pairId, signal())).rejects.toMatchObject({
      code: 'p2p.invalid_server_response'
    })
  })

  it('rejects a malformed entry rather than passing it to the UI', async () => {
    const f = fixture()
    for (const bad of [
      { ref: 'ok', name: '', isDirectory: true, isProject: false },
      { ref: 'has space', name: 'x', isDirectory: true, isProject: false },
      { ref: 'ok', name: 'x', isDirectory: 'yes', isProject: false },
      { ref: 'ok', name: 'x', isDirectory: true }
    ]) {
      f.call.mockResolvedValueOnce({ entries: [bad], total: 1 })
      await expect(
        f.projects.directory(serviceId, pairId, rootId, '', 0, 50, signal())
      ).rejects.toThrow()
    }
  })

  it('refuses an out-of-range page request before dispatch', async () => {
    const f = fixture()
    for (const [offset, limit] of [
      [-1, 50],
      [0, 0],
      [0, MAX_REMOTE_ENTRIES + 1],
      [1.5, 50]
    ])
      await expect(
        f.projects.directory(serviceId, pairId, rootId, '', offset, limit, signal())
      ).rejects.toMatchObject({ code: 'p2p.invalid_request' })
    expect(f.call).not.toHaveBeenCalled()
  })

  it('reports the real total so paging never guesses', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce({ entries: [entry('a', 'alpha', true)], total: 42 })
    const page = await f.projects.directory(serviceId, pairId, rootId, '', 0, 1, signal())
    expect(page.total).toBe(42)
    expect(page.entries[0]?.isProject).toBe(true)
  })

  it('refuses a concurrent browse on the same pair', async () => {
    const f = fixture()
    let release = (): void => {}
    f.call.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ roots: [root] })))
    )
    const first = f.projects.roots(serviceId, pairId, signal())
    await expect(f.projects.roots(serviceId, pairId, signal())).rejects.toMatchObject({
      code: 'p2p.service_busy'
    })
    release()
    await first
  })

  it('refuses any operation once closed', async () => {
    const f = fixture()
    f.projects.close()
    await expect(f.projects.roots(serviceId, pairId, signal())).rejects.toMatchObject({
      code: 'p2p.helper_closed'
    })
  })
})
