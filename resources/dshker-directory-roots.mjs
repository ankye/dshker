/**
 * Launcher-owned Host extension of DSH's in-page directory browser.
 *
 * The Launcher pins the browse directory picker (`dsh-host-directory-picker-browse`
 * plus its client surface) instead of the native chooser, because a paired
 * computer reaching this DSH over P2P cannot see or answer a chooser on this
 * computer's screen. That surface starts at the Host home directory and its
 * breadcrumb only walks ancestors, so on Windows reaching another disk — or on
 * macOS reaching a mounted volume — costs a hand-typed path. Nothing in the
 * Harness browse backend or client surface offers a root (disk/volume) list.
 *
 * This plugin decorates that mounted browse capability instead of replacing it:
 * every listing gains the roots the current level cannot reach by walking
 * (another drive beside a drive-qualified home, a mounted volume beside a POSIX home), each row a
 * real absolute path the browse backend already lists. Listing, creation, error
 * codes and the result bound stay the Harness backend's, so a Harness version
 * change cannot desynchronize a forked copy of that logic.
 *
 * It is inserted by the Launcher's `--patch` overlay through a path relative to
 * that overlay file, never installed into `~/.dsh`, the selected checkout, or a
 * profile. It imports Node builtins only, so it resolves from the application
 * resources directory without a package installation.
 *
 * Failure is never user-visible: an unreadable volume parent, an unresponsive
 * drive letter, or a Host that serves another picker interaction leaves the
 * original listing exactly as the Harness returned it.
 *
 * @module dshker-directory-roots
 */

import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** Cordis plugin name, matching the overlay row's `id` for readable diagnostics. */
export const name = 'dshker-directory-roots'

/**
 * The plugin decorates the composed directory-picking service. Declared as a
 * dependency so Cordis holds this entry until the browse backend registered.
 */
export const inject = ['directoryPicker']

/** Marks a capability this plugin already decorated, so a reload cannot double-wrap it. */
const DECORATED = Symbol.for('dshker.directory-roots')
/** Per-probe ceiling: one unresponsive drive letter must not stall the listing. */
const PROBE_TIMEOUT_MS = 250
/** Root enumeration cache: a level listing happens per navigation, drive probing does not. */
const ROOT_CACHE_TTL_MS = 10_000
/** Every Windows drive letter; a letters-not-volumes probe is the only label-free enumeration Node offers. */
const WINDOWS_DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
/** POSIX parents whose directory children are mount points users expect to reach. */
const VOLUME_PARENTS = new Map([
  ['darwin', ['/Volumes']],
  ['linux', ['/media', '/mnt', '/run/media']]
])

/** Cached enumeration, keyed by the platform and filesystem seam that produced it. */
let cache

/**
 * Resolve a value to the comparison form one platform's paths share: on Windows
 * case and separator variation must not hide a duplicate, on POSIX only a
 * trailing separator may be ignored.
 * @param {string} value - absolute path.
 * @param {NodeJS.Platform} platform - the path syntax to normalize for.
 * @returns {string} comparison form of the path.
 */
function comparablePath(value, platform) {
  const text =
    platform === 'win32' ? String(value).replace(/\\/gu, '/').toLowerCase() : String(value)
  const trimmed = text.replace(/\/+$/u, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * True when `candidate` is `ancestor` or lies beneath it. Used both ways: a root
 * that contains the listed level needs no shortcut (walking up reaches it), and
 * a root the listed level contains is already one of its rows.
 * @param {string} candidate - absolute path to test.
 * @param {string} ancestor - absolute path to test against.
 * @param {NodeJS.Platform} [platform] - the path syntax to compare under.
 * @returns {boolean} whether `candidate` is at or below `ancestor`.
 */
export function isWithinPath(candidate, ancestor, platform = process.platform) {
  if (typeof candidate !== 'string' || typeof ancestor !== 'string') return false
  if (candidate === '' || ancestor === '') return false
  const child = comparablePath(candidate, platform)
  const parent = comparablePath(ancestor, platform)
  if (child === parent) return true
  return child.startsWith(parent === '/' ? '/' : `${parent}/`)
}

/**
 * Shortcut rows for one listing: roots neither above nor below the listed
 * level, and not already listed as a child.
 * @param {object} listing - the browse listing to extend.
 * @param {readonly {name: string, path: string}[]} roots - candidate roots.
 * @param {NodeJS.Platform} [platform] - the path syntax to compare under.
 * @returns {{name: string, path: string, hidden: boolean}[]} rows to prepend, in root order.
 */
export function shortcutRows(listing, roots, platform = process.platform) {
  if (listing === null || typeof listing !== 'object' || typeof listing.path !== 'string') return []
  if (!Array.isArray(roots) || roots.length === 0) return []
  if (listing.path === '') return []
  const entries = Array.isArray(listing.entries) ? listing.entries : []
  const present = new Set(entries.map((entry) => comparablePath(entry.path, platform)))
  const rows = []
  for (const root of roots) {
    if (root === null || typeof root !== 'object') continue
    if (typeof root.path !== 'string' || root.path === '') continue
    if (present.has(comparablePath(root.path, platform))) continue
    if (isWithinPath(listing.path, root.path, platform)) continue
    if (isWithinPath(root.path, listing.path, platform)) continue
    rows.push({ name: String(root.name ?? root.path), path: root.path, hidden: false })
  }
  return rows
}

/**
 * Settle `operation` within `timeoutMs`, keeping the three outcomes apart: a
 * value, a definitive absence, and an unanswered probe. The abandoned probe keeps
 * running, so its result is dropped rather than surfacing as an unhandled
 * rejection.
 * @param {number} timeoutMs - ceiling for the probe.
 * @param {Promise<unknown>} operation - the filesystem probe.
 * @returns {Promise<{value?: unknown, failed: boolean, absent: boolean}>} the outcome.
 */
function within(timeoutMs, operation) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ failed: true, absent: false }), timeoutMs)
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve({ value, failed: false, absent: false })
      },
      (error) => {
        clearTimeout(timer)
        const code =
          typeof error === 'object' && error !== null && 'code' in error ? error.code : ''
        resolve({ failed: true, absent: code === 'ENOENT' || code === 'ENOTDIR' })
      }
    )
  })
}

/** The filesystem seam root enumeration needs, injectable so tests never probe a real disk. */
const defaultIo = {
  /**
   * @param {string} path - candidate root.
   * @returns {Promise<boolean>} whether the path is an existing directory. A drive
   * letter that does not answer is not offered: an unreachable device cannot be
   * browsed either.
   */
  async isDirectory(path) {
    const probe = await within(PROBE_TIMEOUT_MS, stat(path))
    if (probe.failed) return false
    return typeof probe.value.isDirectory === 'function' && probe.value.isDirectory()
  },
  /**
   * @param {string} path - directory whose children may be mount points.
   * @returns {Promise<string[]>} absolute child directory paths; empty when the
   * parent does not exist.
   * @throws when the parent exists but could not be read, so the caller can avoid
   * caching a listing that lost its volumes.
   */
  async readDirectories(path) {
    const probe = await within(PROBE_TIMEOUT_MS, readdir(path, { withFileTypes: true }))
    if (probe.failed) {
      if (probe.absent) return []
      throw new Error(`cannot read ${path}`)
    }
    return probe.value.filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name))
  },
  /**
   * @param {string} path - candidate root.
   * @returns {Promise<string>} the resolved path, or the input when unresolvable.
   */
  async realpath(path) {
    const probe = await within(PROBE_TIMEOUT_MS, realpath(path))
    return typeof probe.value === 'string' && probe.value !== '' ? probe.value : path
  }
}

/**
 * Enumerate the roots one platform offers beyond the home directory.
 * @param {NodeJS.Platform} platform - host platform.
 * @param {typeof defaultIo} io - filesystem seam.
 * @returns {Promise<{name: string, path: string}[]>} roots in display order, deduplicated.
 */
export async function collectRoots(platform, io = defaultIo) {
  return (await enumerateRoots(platform, io)).roots
}

/**
 * Enumerate the roots one platform offers beyond the home directory, reporting
 * whether a mount parent defied read: a complete enumeration may be cached, an
 * incomplete one must be retried instead of hiding a volume for a whole cache
 * lifetime.
 * @param {NodeJS.Platform} platform - host platform.
 * @param {typeof defaultIo} io - filesystem seam.
 * @returns {Promise<{roots: {name: string, path: string}[], complete: boolean}>} roots in display order.
 */
async function enumerateRoots(platform, io) {
  if (platform === 'win32') {
    // Every letter probes concurrently, so one unresponsive drive costs the
    // whole enumeration one probe ceiling (~250 ms) instead of one per letter.
    // A letter that does not answer is treated as absent, not as an unknown that
    // would disable caching on every machine with an empty optical drive.
    const probed = await Promise.all(
      WINDOWS_DRIVE_LETTERS.map(async (letter) => {
        const path = `${letter}:\\`
        return (await io.isDirectory(path)) ? { name: path, path } : undefined
      })
    )
    return {
      roots: dedupeRoots(
        probed.filter((root) => root !== undefined),
        platform
      ),
      complete: true
    }
  }
  const candidates = [{ name: '/', path: '/' }]
  let complete = true
  const parents = VOLUME_PARENTS.get(platform) ?? []
  // Mount parents list concurrently for the same reason, keeping parent order.
  const childrenByParent = await Promise.all(
    parents.map(async (parent) => {
      try {
        return await io.readDirectories(parent)
      } catch {
        complete = false
        return []
      }
    })
  )
  for (const child of childrenByParent.flat()) {
    // A volume mount can be a symlink to the boot volume (`/Volumes/Macintosh
    // HD` → `/`); resolving it lets the duplicate collapse into the root row.
    const resolved = await io.realpath(child)
    candidates.push({ name: basename(resolved) || resolved, path: resolved })
  }
  return { roots: dedupeRoots(candidates, platform), complete }
}

/**
 * @param {{name: string, path: string}[]} roots - candidates in display order.
 * @param {NodeJS.Platform} platform - the path syntax to compare under.
 * @returns {{name: string, path: string}[]} the first candidate for each path.
 */
function dedupeRoots(roots, platform) {
  const seen = new Set()
  const unique = []
  for (const root of roots) {
    const key = comparablePath(root.path, platform)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(root)
  }
  return unique
}

/**
 * Cached root enumeration: drive probing must not run on every navigation, while
 * a newly attached disk still appears within one cache lifetime.
 * @param {NodeJS.Platform} [platform] - host platform.
 * @param {typeof defaultIo} [io] - filesystem seam.
 * @returns {Promise<{name: string, path: string}[]>} roots for the platform.
 */
export async function rootsFor(platform = process.platform, io = defaultIo) {
  const now = Date.now()
  if (cache !== undefined && cache.platform === platform && cache.io === io) {
    if (now - cache.at < ROOT_CACHE_TTL_MS) return cache.roots
  }
  const enumeration = await enumerateRoots(platform, io)
  // A partial enumeration (a mount parent that failed to read) is not cached:
  // the next listing retries instead of hiding the lost volumes for a whole TTL.
  if (enumeration.complete) {
    cache = { platform, io, at: now, roots: enumeration.roots }
  }
  return enumeration.roots
}

/** Forget the enumeration cache. Test seam: production only expires by time. */
export function resetRootCache() {
  cache = undefined
}

/**
 * Prepend root shortcuts to one listing. Returns the listing unchanged whenever
 * roots are unavailable, already represented, or the caller already left.
 * @param {object} listing - the browse listing the backend returned.
 * @param {{platform?: NodeJS.Platform, io?: typeof defaultIo, roots?: readonly {name: string, path: string}[], signal?: AbortSignal}} [options] - seams and caller lifetime.
 * @returns {Promise<object>} the listing, with shortcut rows when there are any.
 */
export async function addRootShortcuts(listing, options = {}) {
  if (listing === null || typeof listing !== 'object') return listing
  if (options.signal !== undefined && options.signal.aborted) return listing
  const platform = options.platform ?? process.platform
  let roots
  try {
    roots = options.roots ?? (await rootsFor(platform, options.io ?? defaultIo))
  } catch {
    return listing
  }
  const rows = shortcutRows(listing, roots, platform)
  if (rows.length === 0) return listing
  return { ...listing, entries: [...rows, ...listing.entries] }
}

/**
 * Decorate one browse capability in place. The seam documents the capability
 * object as stable for the service lifetime, so replacing its `list` function is
 * the extension point that leaves the backend's own list, create, bound, and
 * error paths in place.
 * @param {object} capability - the composed directory-picking capability.
 * @param {{platform?: NodeJS.Platform, io?: typeof defaultIo, roots?: readonly {name: string, path: string}[]}} [options] - seams for tests; production passes none.
 * @returns {boolean} whether this call decorated the capability.
 */
export function decorateCapability(capability, options = {}) {
  if (capability === null || typeof capability !== 'object') return false
  // A native interaction has no listing to extend; the Launcher pins browse, but
  // another composition may mount a picker this plugin does not serve.
  if (capability.kind !== 'browse') return false
  if (typeof capability.list !== 'function' || capability[DECORATED] === true) return false
  const list = capability.list
  const platform = options.platform ?? process.platform
  const io = options.io ?? defaultIo
  const roots = options.roots
  try {
    Object.defineProperty(capability, DECORATED, { value: true, configurable: true })
  } catch {
    // A sealed capability cannot carry the marker that keeps a reload idempotent,
    // so extending it would risk wrapping the same object twice.
    return false
  }
  capability.list = function listWithRoots(path, signal) {
    return Promise.resolve(list.call(this, path, signal)).then((listing) =>
      addRootShortcuts(listing, { signal, platform, io, roots })
    )
  }
  return true
}

/**
 * Cordis entry point: decorate the picker this Host composed, if it is one this
 * plugin serves.
 * @param {{directoryPicker?: {capability: () => object}}} ctx - the Cordis context.
 */
export function apply(ctx) {
  const picker = ctx?.directoryPicker
  if (typeof picker?.capability !== 'function') return
  decorateCapability(picker.capability())
}
