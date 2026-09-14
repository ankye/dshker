import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ManagedRootError } from '../managed/errors'
import {
  P2P_SELECTION_FORMAT,
  P2P_SELECTION_VERSION,
  P2PSelectionStore,
  parseP2PSelection,
  p2pSelectionFilePath
} from './selection-preferences'

const serviceId = 'c'.repeat(12)
const otherService = 'd'.repeat(12)
const userId = 'a'.repeat(12)
const otherUser = 'b'.repeat(12)
const networkId = '1'.repeat(12)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

async function openStore() {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'p2p-selection-'))
  roots.push(root)
  return { root, store: new P2PSelectionStore({ resolveSettingsRoot: async () => root }) }
}

describe('P2P selection memory', () => {
  it('creates the empty record on first read instead of failing', async () => {
    const { root, store } = await openStore()
    expect(await store.remembered(serviceId, userId)).toBeUndefined()
    const record = JSON.parse(await readFile(p2pSelectionFilePath(root), 'utf8'))
    expect(record).toEqual({
      format: P2P_SELECTION_FORMAT,
      version: P2P_SELECTION_VERSION,
      services: {}
    })
  })

  it('remembers an explicit choice for the account that made it', async () => {
    const { store } = await openStore()
    await store.remember(serviceId, userId, networkId)
    expect(await store.remembered(serviceId, userId)).toBe(networkId)
    // Another account on the same service never inherits the choice.
    expect(await store.remembered(serviceId, otherUser)).toBeUndefined()
    // And another service is untouched.
    expect(await store.remembered(otherService, userId)).toBeUndefined()
  })

  it('forgets one service without disturbing the others', async () => {
    const { store } = await openStore()
    await store.remember(serviceId, userId, networkId)
    await store.remember(otherService, userId, networkId)
    await store.forget(serviceId)
    expect(await store.remembered(serviceId, userId)).toBeUndefined()
    expect(await store.remembered(otherService, userId)).toBe(networkId)
  })

  it('refuses an unknown field, a future version and a malformed id', () => {
    const base = { format: P2P_SELECTION_FORMAT, version: P2P_SELECTION_VERSION, services: {} }
    expect(() => parseP2PSelection(JSON.stringify({ ...base, extra: true }))).toThrow(
      ManagedRootError
    )
    expect(() => parseP2PSelection(JSON.stringify({ ...base, version: 2 }))).toThrow(
      ManagedRootError
    )
    expect(() =>
      parseP2PSelection(
        JSON.stringify({ ...base, services: { [serviceId]: { userId, networkId: 'nope' } } })
      )
    ).toThrow(ManagedRootError)
  })

  it('keeps the file private to the owner', async () => {
    const { root, store } = await openStore()
    await store.remember(serviceId, userId, networkId)
    const { mode } = await import('node:fs/promises').then((fs) =>
      fs.stat(p2pSelectionFilePath(root))
    )
    // POSIX mode bits are the privacy contract the store writes (0o600). Windows
    // synthesizes them from ACLs, so the bits there do not state ownership and
    // asserting them would fail every Windows release without proving anything.
    if (process.platform !== 'win32') expect(mode & 0o077).toBe(0)
  })
})
