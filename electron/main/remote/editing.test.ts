import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteConnectionCatalog, remoteConfigRevision } from './catalog'
import { RemoteConnectionService } from './service'
import type {
  RemoteComputerView,
  UpdateRemoteConnectionRequest
} from '../../../src/shared/contracts'

let root: string
let catalog: RemoteConnectionCatalog
let computer: RemoteComputerView
let file: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dshker-edit-'))
  await mkdir(path.join(root, 'dsh-launcher'))
  file = path.join(root, 'dsh-launcher', 'remote-connections.json')
  catalog = new RemoteConnectionCatalog({ resolveSettingsRoot: async () => root })
  computer = (
    await catalog.create({
      displayName: 'Studio',
      host: 'studio.local',
      port: 22,
      user: 'developer'
    })
  )[0]!
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function request(
  changes: Partial<UpdateRemoteConnectionRequest> = {}
): UpdateRemoteConnectionRequest {
  return { ...computer, expectedConfigRevision: remoteConfigRevision(computer), ...changes }
}

describe('remote editing persistence', () => {
  it('atomically updates exact fields, retains identity/order/format, and reads back after reopen', async () => {
    const second = (
      await catalog.create({ displayName: 'Office', host: 'office', port: 2222, user: 'operator' })
    )[1]!
    const updated = await catalog.update(
      request({ displayName: '工作室', host: 'build.local', port: 222, user: 'builder' })
    )
    expect(updated[0]).toEqual({
      connectionId: computer.connectionId,
      displayName: '工作室',
      host: 'build.local',
      port: 222,
      user: 'builder'
    })
    expect(updated[1]).toEqual(second)
    const reopened = new RemoteConnectionCatalog({ resolveSettingsRoot: async () => root })
    expect(await reopened.load()).toEqual(updated)
    const persisted = JSON.parse(await readFile(file, 'utf8'))
    expect(persisted).toEqual({
      format: 'dsh-launcher.remote-connections',
      version: 1,
      connections: updated
    })
    expect(persisted.connections[0]).not.toHaveProperty('configRevision')
  })

  it('does not rewrite a no-op and rejects stale, invalid and removed targets without overwriting', async () => {
    const before = await stat(file)
    await catalog.update(request())
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
    await catalog.update(request({ displayName: 'Updated' }))
    const bytes = await readFile(file)
    await expect(catalog.update(request({ host: 'stale' }))).rejects.toMatchObject({
      code: 'remote.config_conflict'
    })
    for (const port of [0, -1, 65_536, 1.5, Number.NaN]) {
      await expect(catalog.update(request({ port }))).rejects.toMatchObject({
        code: 'remote.invalid_request'
      })
    }
    expect(await readFile(file)).toEqual(bytes)
    await catalog.remove(computer.connectionId)
    await expect(catalog.update(request())).rejects.toMatchObject({
      code: 'remote.connection_not_found'
    })
    expect(await catalog.load()).toEqual([])
  })

  it('serializes competing writes and prevents stale revisions from winning', async () => {
    const results = await Promise.allSettled([
      catalog.update(request({ displayName: 'Winner' })),
      catalog.update(request({ host: 'stale-host' }))
    ])
    expect(results.map((entry) => entry.status)).toEqual(['fulfilled', 'rejected'])
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({
      code: 'remote.config_conflict'
    })
    expect(await catalog.load()).toEqual([{ ...computer, displayName: 'Winner' }])
  })

  it('preserves all fields when duplicate-name validation rejects the update', async () => {
    await catalog.create({ displayName: 'Office', host: 'office', port: 22, user: 'dev' })
    const before = await readFile(file)
    await expect(
      catalog.update(request({ displayName: 'office', host: 'changed' }))
    ).rejects.toMatchObject({ code: 'remote.connection_exists' })
    expect(await readFile(file)).toEqual(before)
  })
})

describe('remote editing lifecycle', () => {
  it('renames a live connection without closing or changing its URL and only invalidates tests after disconnected parameter updates', async () => {
    const stop = vi.fn(async () => undefined)
    const connect = vi.fn(async (_computer: RemoteComputerView) => ({
      url: 'http://127.0.0.1:41000/',
      stop
    }))
    const service = new RemoteConnectionService(catalog, { connect })
    const before = (await service.connect(computer.connectionId)).connections[0]!
    const renamed = (await service.update(request({ displayName: 'Renamed' }))).connections[0]!
    expect(renamed.connectionId).toBe(before.connectionId)
    expect(renamed.status).toEqual(before.status)
    expect(renamed.testStatus).toEqual(before.testStatus)
    expect(stop).not.toHaveBeenCalled()
    const update = {
      ...request({ displayName: 'Renamed', host: 'new-host' }),
      expectedConfigRevision: renamed.configRevision
    }
    await expect(service.update(update)).rejects.toMatchObject({
      code: 'remote.connection_not_disconnected'
    })
    expect((await catalog.load())[0]?.host).toBe(computer.host)
    await service.disconnect(computer.connectionId)
    const saved = (await service.update(update)).connections[0]!
    expect(saved.status).toEqual({ kind: 'disconnected' })
    expect(saved.testStatus).toEqual({ kind: 'untested' })
    expect(saved.host).toBe('new-host')
    await service.connect(computer.connectionId)
    expect(connect.mock.lastCall?.[0]).toMatchObject({
      host: 'new-host',
      connectionId: computer.connectionId
    })
    await service.shutdown()
  })

  it('blocks test, connect and removal while a record update owns its lock', async () => {
    let release: (() => void) | undefined
    const pause = new Promise<void>((resolve) => {
      release = resolve
    })
    const store = {
      load: () => catalog.load(),
      create: catalog.create.bind(catalog),
      remove: catalog.remove.bind(catalog),
      update: async (value: UpdateRemoteConnectionRequest) => {
        await pause
        return catalog.update(value)
      }
    }
    const service = new RemoteConnectionService(store, { connect: vi.fn() })
    const saving = service.update(request({ displayName: 'New name' }))
    await expect(service.connect(computer.connectionId)).rejects.toMatchObject({
      code: 'remote.connection_busy'
    })
    await expect(service.test(computer.connectionId)).rejects.toMatchObject({
      code: 'remote.connection_busy'
    })
    await expect(service.remove(computer.connectionId)).rejects.toMatchObject({
      code: 'remote.connection_busy'
    })
    release!()
    expect((await saving).connections[0]?.displayName).toBe('New name')
  })
})
