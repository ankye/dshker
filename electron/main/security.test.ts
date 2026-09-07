import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' },
  BrowserWindow: { fromWebContents: () => ({}) },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) }
}))

const { installWebviewPolicy } = await import('./security')
const { LOCAL_PARTITION, peerPartition } = await import('./p2p/partitions')

const serviceId = 'a'.repeat(64)
const pairA = '1'.repeat(32)
const pairB = '2'.repeat(32)
const loopback = 'http://127.0.0.1:51234/'

/** Drives one `will-attach-webview` decision and reports whether it was denied. */
function attach(params: Record<string, unknown>) {
  const contents = new EventEmitter() as EventEmitter & { setWindowOpenHandler?: unknown }
  installWebviewPolicy(contents as never, { attach: () => {} } as never)
  let denied = false
  const preferences: Record<string, unknown> = { preload: '/evil/preload.js' }
  contents.emit(
    'will-attach-webview',
    { preventDefault: () => (denied = true) },
    preferences,
    params
  )
  return { denied, preferences }
}

describe('run guest attach policy', () => {
  it('strips preload and forces isolation regardless of the requested value', () => {
    const { preferences } = attach({ src: loopback, partition: LOCAL_PARTITION })
    expect(preferences.preload).toBeUndefined()
    expect(preferences.nodeIntegration).toBe(false)
    expect(preferences.contextIsolation).toBe(true)
    expect(preferences.sandbox).toBe(true)
  })

  it('admits the Local partition and an allocated peer partition', () => {
    expect(attach({ src: loopback, partition: LOCAL_PARTITION }).denied).toBe(false)
    expect(attach({ src: loopback, partition: peerPartition(serviceId, pairA) }).denied).toBe(false)
  })

  it('admits an attach that names no partition, keeping existing behaviour', () => {
    expect(attach({ src: loopback }).denied).toBe(false)
  })

  it('refuses a hand-written partition that this app never allocated', () => {
    for (const partition of [
      'persist:dsh-peer-not-a-real-digest',
      'persist:someone-else',
      'persist:',
      'dsh-peer-1234',
      '',
      42,
      null
    ])
      expect(attach({ src: loopback, partition }).denied, String(partition)).toBe(true)
  })

  it('still refuses a non-loopback source even with a valid partition', () => {
    expect(attach({ src: 'https://example.com/', partition: LOCAL_PARTITION }).denied).toBe(true)
  })

  it('keeps two computers in different partitions so cookies cannot be shared', () => {
    expect(peerPartition(serviceId, pairA)).not.toBe(peerPartition(serviceId, pairB))
    expect(attach({ src: loopback, partition: peerPartition(serviceId, pairB) }).denied).toBe(false)
  })
})
