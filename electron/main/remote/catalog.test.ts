import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RemoteConnectionCatalog, parseRemoteConnectionsRecord } from './catalog'
import { RemoteConnectionError } from './errors'

let root: string
let settingsRoot: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dshker-remote-catalog-'))
  settingsRoot = path.join(root, 'settings')
  await mkdir(path.join(settingsRoot, 'dsh-launcher'), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('RemoteConnectionCatalog', () => {
  it('creates an empty exact record only when the file is absent', async () => {
    const catalog = new RemoteConnectionCatalog({ resolveSettingsRoot: async () => settingsRoot })
    expect(await catalog.load()).toEqual([])
    const text = await readFile(
      path.join(settingsRoot, 'dsh-launcher', 'remote-connections.json'),
      'utf8'
    )
    expect(parseRemoteConnectionsRecord(text).connections).toEqual([])
  })

  it('round-trips stable computer fields and omits runtime authority', async () => {
    const catalog = new RemoteConnectionCatalog({ resolveSettingsRoot: async () => settingsRoot })
    const connections = await catalog.create({
      displayName: 'Studio Mac',
      host: 'studio-mac.local',
      port: 22,
      user: 'developer'
    })
    expect(connections).toHaveLength(1)
    expect(connections[0]).toMatchObject({
      displayName: 'Studio Mac',
      host: 'studio-mac.local',
      port: 22,
      user: 'developer'
    })
    const text = await readFile(
      path.join(settingsRoot, 'dsh-launcher', 'remote-connections.json'),
      'utf8'
    )
    expect(text).not.toContain('token')
    expect(text).not.toContain('url')
    expect(await catalog.load()).toEqual(connections)
  })

  it('rejects duplicate names, malformed fields, unknown fields, and unsupported versions', async () => {
    const catalog = new RemoteConnectionCatalog({ resolveSettingsRoot: async () => settingsRoot })
    await catalog.create({ displayName: 'Office', host: 'office', port: 22, user: 'dev' })
    await expect(
      catalog.create({ displayName: 'office', host: 'other', port: 22, user: 'dev' })
    ).rejects.toMatchObject({ code: 'remote.connection_exists' })
    await expect(
      catalog.create({ displayName: 'Bad', host: '-oProxyCommand=x', port: 22, user: 'dev' })
    ).rejects.toMatchObject({ code: 'remote.invalid_request' })

    const filePath = path.join(settingsRoot, 'dsh-launcher', 'remote-connections.json')
    await writeFile(
      filePath,
      JSON.stringify({
        format: 'dsh-launcher.remote-connections',
        version: 1,
        connections: [],
        extra: true
      })
    )
    await expect(catalog.load()).rejects.toBeInstanceOf(RemoteConnectionError)
    await writeFile(
      filePath,
      JSON.stringify({ format: 'dsh-launcher.remote-connections', version: 2, connections: [] })
    )
    await expect(catalog.load()).rejects.toMatchObject({ code: 'remote.unsupported_version' })
  })
})
