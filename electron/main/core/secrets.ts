// The main-only view of the core's native secret store.
// Values are opaque bytes; no plaintext key material reaches the renderer.
import type { PeerRpc } from '../p2p/rpc'
import { PeerHelperError } from '../p2p/wire'

export interface CoreSecretPort {
  get(key: string, signal?: AbortSignal): Promise<Buffer | undefined>
  set(key: string, value: Buffer, signal?: AbortSignal): Promise<void>
  delete(key: string, signal?: AbortSignal): Promise<void>
}

const MAX_KEY_BYTES = 256
const CALL_BUDGET_MS = 30_000

function assertKey(key: string): void {
  if (key === '' || Buffer.byteLength(key) > MAX_KEY_BYTES)
    throw new PeerHelperError('p2p.invalid_payload')
}

function budget(signal?: AbortSignal): AbortSignal {
  return signal ?? AbortSignal.timeout(CALL_BUDGET_MS)
}

function asRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new PeerHelperError('p2p.invalid_payload')
  const record = value as Record<string, unknown>
  for (const field of fields) {
    if (!(field in record)) throw new PeerHelperError('p2p.invalid_payload')
  }
  return record
}

/** Calls the core.secret_* methods of a live dshkerd over its private channel. */
export class CoreSecrets implements CoreSecretPort {
  readonly #rpc: Pick<PeerRpc, 'call'>

  constructor(rpc: Pick<PeerRpc, 'call'>) {
    this.#rpc = rpc
  }

  async get(key: string, signal?: AbortSignal): Promise<Buffer | undefined> {
    assertKey(key)
    let result: unknown
    try {
      result = await this.#rpc.call('core.secret_get', { key }, budget(signal))
    } catch (error) {
      // The core's typed "not stored" refusal is the miss signal, not a failure.
      if (error instanceof PeerHelperError && error.code === 'p2p.secret_missing') return undefined
      throw error
    }
    const record = asRecord(result, ['value'])
    if (typeof record.value !== 'string') throw new PeerHelperError('p2p.invalid_payload')
    return Buffer.from(record.value, 'base64')
  }

  async set(key: string, value: Buffer, signal?: AbortSignal): Promise<void> {
    assertKey(key)
    await this.#rpc.call(
      'core.secret_set',
      { key, value: value.toString('base64') },
      budget(signal)
    )
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    assertKey(key)
    await this.#rpc.call('core.secret_delete', { key }, budget(signal))
  }
}
