import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { CoreCatalogPort } from '../core/catalog'
import {
  MAX_CATALOG_BYTES,
  parsePeerCatalog,
  type PeerCatalogRecord,
  type PeerCatalogSnapshot
} from './catalog-schema'
import { assertPeerCatalogTransition } from './catalog-transition'
import { exactPeerObject, parsePeerJson, PeerHelperError } from './wire'

export type { PeerCatalogSnapshot } from './catalog-schema'

const UNSERVED: unique symbol = Symbol('the core does not serve the catalog')

/**
 * The refusals that mean a live core simply has no catalog behind it: a core
 * built before these methods were published, and one started without a catalog
 * directory. A transport failure is deliberately absent — falling back while a
 * core is alive but unreachable would recreate the second writer this routing
 * exists to remove.
 */
const CORE_UNSERVED = new Set([
  'p2p.catalog_unavailable',
  'p2p.not_implemented',
  'p2p.invalid_operation'
])

/**
 * Registered-root persistence, with explicit first enable and no missing-file reset.
 *
 * The catalog lives in the settings root, where the shell has always written
 * it, so the core adopts an existing `p2p-devices.json` in place: same file,
 * same format, same sha256-of-bytes revision. When a core is injected the shell
 * consults it first and never touches the file itself, so there is exactly one
 * writer. The file path below is kept as the degraded path for a shell that
 * started without a usable core, and it disappears when the core becomes
 * mandatory.
 */
export class PeerCatalog {
  #pending: Promise<unknown> = Promise.resolve()
  readonly #port: CoreCatalogPort | undefined
  /** Cleared the first time a live core answers that it has no catalog. */
  #coreServes: boolean

  constructor(
    private readonly resolveSettingsRoot: () => Promise<string>,
    core?: CoreCatalogPort
  ) {
    this.#port = core
    this.#coreServes = core !== undefined
  }

  inspect(): Promise<PeerCatalogSnapshot | undefined> {
    return this.#serialize(async () => {
      const routed = await this.#onCore((port) => port.inspect())
      return routed === UNSERVED ? this.#inspectLocal() : routed
    })
  }

  enable(): Promise<PeerCatalogSnapshot> {
    return this.#serialize(async () => {
      const routed = await this.#onCore((port) => port.enable())
      return routed === UNSERVED ? this.#enableLocal() : routed
    })
  }

  /** Main workflows must authorize their named mutation before calling commit. */
  commit(expectedRevision: string, next: PeerCatalogRecord): Promise<PeerCatalogSnapshot> {
    // Copy and validate synchronously: a caller cannot mutate queued input, and
    // the core's own re-validation is never the first line of defence.
    const encoded = JSON.stringify(next)
    const validated = parsePeerCatalog(encoded)
    return this.#serialize(async () => {
      const routed = await this.#onCore((port) => port.commit(expectedRevision, validated))
      return routed === UNSERVED ? this.#commitLocal(expectedRevision, validated) : routed
    })
  }

  /**
   * Removes one service by id.
   *
   * The local implementation reads and writes deliberately tolerantly so a
   * legacy or partially-corrupt record (e.g. an old certificate that no longer
   * passes strict re-validation) cannot block deleting it, and the core does the
   * same on its side. Purely local either way: no server is contacted, so
   * removing a coordinator the user no longer runs succeeds.
   */
  removeService(serviceId: string): Promise<PeerCatalogSnapshot> {
    return this.#serialize(async () => {
      const routed = await this.#onCore((port) => port.removeService(serviceId))
      return routed === UNSERVED ? this.#removeServiceLocal(serviceId) : routed
    })
  }

  /**
   * Runs one operation against the core, latching onto the local file for the
   * rest of the process when the core proves it has no catalog at all.
   */
  async #onCore<R>(operation: (port: CoreCatalogPort) => Promise<R>): Promise<R | typeof UNSERVED> {
    if (this.#port === undefined || !this.#coreServes) return UNSERVED
    try {
      return await operation(this.#port)
    } catch (error) {
      if (!(error instanceof PeerHelperError) || !CORE_UNSERVED.has(error.code)) throw error
      this.#coreServes = false
      return UNSERVED
    }
  }

  async #inspectLocal(): Promise<PeerCatalogSnapshot | undefined> {
    const parent = await this.#parent()
    const file = join(parent, 'p2p-devices.json')
    const marker = join(parent, 'p2p-enabled.json')
    const [catalogExists, markerExists] = await Promise.all([exists(file), exists(marker)])
    if (!catalogExists && !markerExists) return undefined // Explicit never-enabled state only.
    if (!catalogExists || !markerExists) throw new PeerHelperError('p2p.catalog_incomplete')
    return this.#read(parent)
  }

  async #enableLocal(): Promise<PeerCatalogSnapshot> {
    const parent = await this.#parent()
    const file = join(parent, 'p2p-devices.json')
    const marker = join(parent, 'p2p-enabled.json')
    if ((await exists(file)) || (await exists(marker)))
      throw new PeerHelperError('p2p.catalog_exists')
    const catalogId = randomBytes(16).toString('hex')
    const record: PeerCatalogRecord = {
      format: 'dshker.p2p-devices',
      version: 1,
      catalogId,
      services: [],
      computers: [],
      forgottenServiceIds: []
    }
    await publish(file, JSON.stringify(record), false)
    await publish(marker, JSON.stringify({ version: 1, catalogId }), false)
    return this.#read(parent)
  }

  async #commitLocal(
    expectedRevision: string,
    validated: PeerCatalogRecord
  ): Promise<PeerCatalogSnapshot> {
    const parent = await this.#parent()
    const previous = await this.#read(parent)
    if (previous.revision !== expectedRevision || previous.record.catalogId !== validated.catalogId)
      throw new PeerHelperError('p2p.catalog_conflict')
    assertPeerCatalogTransition(previous.record, validated)
    if (JSON.stringify(previous.record) === JSON.stringify(validated)) return previous
    await publish(join(parent, 'p2p-devices.json'), JSON.stringify(validated), true)
    return this.#read(parent)
  }

  async #removeServiceLocal(serviceId: string): Promise<PeerCatalogSnapshot> {
    const parent = await this.#parent()
    const file = join(parent, 'p2p-devices.json')
    const raw = await readRecord(file)
    // Tolerant: keep only the fields we need, drop the target service and its
    // computers, and forget the identity. Rejects if the identity was already
    // forgotten, mirroring the strict path.
    let parsed: PeerCatalogRecord
    try {
      parsed = parsePeerCatalog(raw)
    } catch {
      // The record failed strict validation. Fall through to a minimal,
      // forward-only removal rather than blocking deletion forever.
      const obj = exactPeerObject(parsePeerJson(raw), [
        'format',
        'version',
        'catalogId',
        'services',
        'computers',
        'forgottenServiceIds'
      ]) as unknown as PeerCatalogRecord
      if (
        obj.format !== 'dshker.p2p-devices' ||
        obj.version !== 1 ||
        !Array.isArray(obj.services) ||
        !Array.isArray(obj.computers) ||
        !Array.isArray(obj.forgottenServiceIds)
      )
        throw new PeerHelperError('p2p.catalog_invalid')
      parsed = obj
    }
    if (parsed.forgottenServiceIds.includes(serviceId))
      throw new PeerHelperError('p2p.trust_restore_rejected')
    if (!parsed.services.some((value) => value.serviceId === serviceId))
      throw new PeerHelperError('p2p.service_not_found')
    const next: PeerCatalogRecord = {
      ...parsed,
      services: parsed.services.filter((value) => value.serviceId !== serviceId),
      computers: parsed.computers.filter((value) => value.serviceId !== serviceId),
      forgottenServiceIds: [...parsed.forgottenServiceIds, serviceId]
    }
    // Re-validate the result so the file can never be written unreadable.
    const validated = parsePeerCatalog(JSON.stringify(next))
    await publish(file, JSON.stringify(validated), true)
    return this.#read(parent)
  }

  async #parent(): Promise<string> {
    const root = await this.resolveSettingsRoot()
    if (!isAbsolute(root)) throw new PeerHelperError('p2p.settings_root_required')
    const parent = join(root, 'dsh-launcher')
    const info = await lstat(parent).catch(() => {
      throw new PeerHelperError('p2p.settings_root_required')
    })
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new PeerHelperError('p2p.settings_root_required')
    return parent
  }

  async #read(parent: string): Promise<PeerCatalogSnapshot> {
    try {
      const raw = await readRecord(join(parent, 'p2p-devices.json'))
      const record = parsePeerCatalog(raw)
      const marker = exactPeerObject(
        parsePeerJson(await readRecord(join(parent, 'p2p-enabled.json'))),
        ['version', 'catalogId']
      )
      if (marker.version !== 1 || marker.catalogId !== record.catalogId)
        throw new PeerHelperError('p2p.catalog_invalid')
      return { revision: createHash('sha256').update(raw).digest('hex'), record }
    } catch (error) {
      if (error instanceof PeerHelperError) throw error
      throw new PeerHelperError('p2p.catalog_unavailable')
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#pending.then(operation)
    this.#pending = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new PeerHelperError('p2p.catalog_unavailable')
  }
}
async function readRecord(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CATALOG_BYTES)
    throw new PeerHelperError('p2p.catalog_invalid')
  return readFile(path, 'utf8')
}
async function publish(path: string, text: string, replace: boolean): Promise<void> {
  const temporary = path + '.' + randomBytes(16).toString('hex') + '.tmp'
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(text)
    await file.sync()
    await file.close()
    if (replace) await replaceFile(temporary, path)
    else {
      await link(temporary, path)
      await unlink(temporary)
    }
  } catch {
    await file.close()
    if (await exists(temporary)) await unlink(temporary)
    throw new PeerHelperError('p2p.catalog_write_failed')
  }
}

/** Node's rename cannot replace an existing file on Windows; preserve the old record while swapping. */
async function replaceFile(temporary: string, target: string): Promise<void> {
  try {
    await rename(temporary, target)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (process.platform !== 'win32' || !['EACCES', 'EEXIST', 'EPERM'].includes(code ?? ''))
      throw error
  }

  const backup = `${target}.${randomBytes(16).toString('hex')}.bak`
  await rename(target, backup)
  try {
    await rename(temporary, target)
  } catch (error) {
    await rename(backup, target).catch(() => undefined)
    throw error
  }
  await unlink(backup)
}
