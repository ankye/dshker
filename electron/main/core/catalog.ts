// The main-only view of the core's device catalog.
//
// The record shape is the one the shell already wrote, so routing the catalog
// through the core changes who persists it and nothing about what persists: no
// new field, no new file, no new plaintext, and the same sha256-of-bytes
// revision. Only Electron main ever holds one of these.
import {
  parsePeerCatalog,
  type PeerCatalogRecord,
  type PeerCatalogSnapshot
} from '../p2p/catalog-schema'
import type { PeerRpc } from '../p2p/rpc'
import { PeerHelperError } from '../p2p/wire'

/** The catalog operations the shell performs, wherever they are served. */
export interface CoreCatalogPort {
  inspect(signal?: AbortSignal): Promise<PeerCatalogSnapshot | undefined>
  enable(signal?: AbortSignal): Promise<PeerCatalogSnapshot>
  commit(
    expectedRevision: string,
    next: PeerCatalogRecord,
    signal?: AbortSignal
  ): Promise<PeerCatalogSnapshot>
  removeService(serviceId: string, signal?: AbortSignal): Promise<PeerCatalogSnapshot>
}

const CALL_BUDGET_MS = 30_000

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

/**
 * Projects one core answer. A core that has never been enabled answers
 * `{enabled:false}` — a state the shell renders as an invitation, never as a
 * failure — and every other answer must carry a well-formed record, which is
 * re-parsed with the validator the shell used while it owned the file so a core
 * bug can never hand the app a record it cannot read back.
 */
function snapshot(value: unknown): PeerCatalogSnapshot | undefined {
  const enabled = asRecord(value, ['enabled']).enabled
  if (enabled === false) return undefined
  if (enabled !== true) throw new PeerHelperError('p2p.invalid_payload')
  const answer = asRecord(value, ['enabled', 'revision', 'record'])
  if (typeof answer.revision !== 'string' || !/^[0-9a-f]{64}$/.test(answer.revision))
    throw new PeerHelperError('p2p.invalid_payload')
  const record = parsePeerCatalog(JSON.stringify(answer.record))
  return { revision: answer.revision, record }
}

function required(value: unknown): PeerCatalogSnapshot {
  const result = snapshot(value)
  if (result === undefined) throw new PeerHelperError('p2p.catalog_invalid')
  return result
}

/** Calls the core.catalog_* methods of a live dshkerd over its private channel. */
export class CoreCatalog implements CoreCatalogPort {
  readonly #rpc: Pick<PeerRpc, 'call'>

  constructor(rpc: Pick<PeerRpc, 'call'>) {
    this.#rpc = rpc
  }

  async inspect(signal?: AbortSignal): Promise<PeerCatalogSnapshot | undefined> {
    return snapshot(await this.#rpc.call('core.catalog_inspect', {}, budget(signal)))
  }

  async enable(signal?: AbortSignal): Promise<PeerCatalogSnapshot> {
    return required(await this.#rpc.call('core.catalog_enable', {}, budget(signal)))
  }

  async commit(
    expectedRevision: string,
    next: PeerCatalogRecord,
    signal?: AbortSignal
  ): Promise<PeerCatalogSnapshot> {
    return required(
      await this.#rpc.call(
        'core.catalog_commit',
        { expectedRevision, record: next },
        budget(signal)
      )
    )
  }

  async removeService(serviceId: string, signal?: AbortSignal): Promise<PeerCatalogSnapshot> {
    return required(
      await this.#rpc.call('core.catalog_remove_service', { serviceId }, budget(signal))
    )
  }
}
