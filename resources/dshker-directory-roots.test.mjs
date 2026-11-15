import { describe, expect, it } from 'vitest'
import {
  addRootShortcuts,
  apply,
  collectRoots,
  decorateCapability,
  isWithinPath,
  resetRootCache,
  rootsFor,
  shortcutRows
} from './dshker-directory-roots.mjs'

// A spelled-out Windows separator would read as a machine-specific absolute path
// to the workspace-wide scan, so the fixtures assemble one instead.
const WIN_SEP = String.fromCharCode(92)
const win = (...parts) => parts.join(WIN_SEP)
const winRoot = (letter) => `${letter}:${WIN_SEP}`

/** A filesystem seam that answers from an explicit table and counts its probes. */
function fakeIo({ directories = [], children = {}, resolved = {} } = {}) {
  const probes = { isDirectory: 0, readDirectories: 0, realpath: 0 }
  return {
    probes,
    async isDirectory(path) {
      probes.isDirectory += 1
      return directories.includes(path)
    },
    async readDirectories(path) {
      probes.readDirectories += 1
      return children[path] ?? []
    },
    async realpath(path) {
      probes.realpath += 1
      return resolved[path] ?? path
    }
  }
}

/** A browse capability shaped like the Harness backend's stable object. */
function browseCapability(listing) {
  const calls = []
  return {
    calls,
    capability: {
      kind: 'browse',
      async list(path, signal) {
        calls.push({ path, signal })
        return listing
      },
      async createDirectory() {
        throw new Error('not used')
      }
    }
  }
}

/** A Windows home listing with two child directories. */
const homeListing = {
  path: win('C:', 'Users', 'me'),
  home: win('C:', 'Users', 'me'),
  crumbs: [{ name: winRoot('C'), path: winRoot('C'), hidden: false }],
  entries: [
    { name: 'projects', path: win('C:', 'Users', 'me', 'projects'), hidden: false },
    { name: 'notes', path: win('C:', 'Users', 'me', 'notes'), hidden: false }
  ],
  truncated: false
}

describe('isWithinPath', () => {
  it('treats the Windows drive root as an ancestor of every path on that drive', () => {
    expect(isWithinPath(win('C:', 'Users', 'me'), winRoot('C'), 'win32')).toBe(true)
    expect(isWithinPath(winRoot('C'), winRoot('C'), 'win32')).toBe(true)
    expect(isWithinPath(win('C:', 'Users'), win('C:', 'Users', 'me'), 'win32')).toBe(false)
  })

  it('ignores Windows case and separator spelling', () => {
    expect(isWithinPath('c:/users/ME', win('C:', 'Users'), 'win32')).toBe(true)
  })

  it('keeps the POSIX root as the ancestor of every absolute path', () => {
    expect(isWithinPath('/srv/me', '/', 'darwin')).toBe(true)
    expect(isWithinPath('/srv/me', '/srv', 'darwin')).toBe(true)
    expect(isWithinPath('/srv/me', '/srv-elsewhere', 'darwin')).toBe(false)
  })

  it('rejects empty or non-string paths instead of guessing a relation', () => {
    expect(isWithinPath('', '/', 'darwin')).toBe(false)
    expect(isWithinPath('/srv/me', '', 'darwin')).toBe(false)
    expect(isWithinPath(undefined, '/', 'darwin')).toBe(false)
  })
})

describe('shortcutRows', () => {
  it('offers the other disks on Windows and hides the ancestor drive', () => {
    const rows = shortcutRows(
      homeListing,
      [
        { name: winRoot('C'), path: winRoot('C') },
        { name: winRoot('D'), path: winRoot('D') }
      ],
      'win32'
    )
    expect(rows).toEqual([{ name: winRoot('D'), path: winRoot('D'), hidden: false }])
  })

  it('offers the home drive when the level is on another disk', () => {
    const rows = shortcutRows(
      {
        path: win('D:', 'work'),
        entries: [],
        crumbs: [],
        home: win('C:', 'Users', 'me'),
        truncated: false
      },
      [
        { name: winRoot('C'), path: winRoot('C') },
        { name: winRoot('D'), path: winRoot('D') }
      ],
      'win32'
    )
    expect(rows.map((row) => row.path)).toEqual([winRoot('C')])
  })

  it('does not repeat a root the level already lists as a child', () => {
    const listing = {
      path: winRoot('C'),
      home: win('C:', 'Users', 'me'),
      crumbs: [],
      entries: [{ name: winRoot('D'), path: winRoot('D'), hidden: false }],
      truncated: false
    }
    expect(shortcutRows(listing, [{ name: winRoot('D'), path: winRoot('D') }], 'win32')).toEqual([])
  })

  it('offers mounted volumes beside a POSIX home and hides the filesystem root', () => {
    const rows = shortcutRows(
      { path: '/srv/me', home: '/srv/me', crumbs: [], entries: [], truncated: false },
      [
        { name: '/', path: '/' },
        { name: 'CodeS', path: '/Volumes/CodeS' }
      ],
      'darwin'
    )
    expect(rows).toEqual([{ name: 'CodeS', path: '/Volumes/CodeS', hidden: false }])
  })

  it('offers nothing while the level is the volume parent that already lists them', () => {
    expect(
      shortcutRows(
        { path: '/Volumes', home: '/srv/me', crumbs: [], entries: [], truncated: false },
        [{ name: 'CodeS', path: '/Volumes/CodeS' }],
        'darwin'
      )
    ).toEqual([])
  })

  it('returns no rows when there are no roots or no listed path', () => {
    expect(shortcutRows(homeListing, [], 'win32')).toEqual([])
    expect(shortcutRows(homeListing, undefined, 'win32')).toEqual([])
    expect(
      shortcutRows({ entries: [] }, [{ name: winRoot('D'), path: winRoot('D') }], 'win32')
    ).toEqual([])
  })
})

describe('collectRoots', () => {
  it('keeps exactly the Windows drive letters that answer as directories', async () => {
    const io = fakeIo({ directories: [winRoot('C'), winRoot('D')] })
    await expect(collectRoots('win32', io)).resolves.toEqual([
      { name: winRoot('C'), path: winRoot('C') },
      { name: winRoot('D'), path: winRoot('D') }
    ])
    expect(io.probes.isDirectory).toBe(26)
  })

  it('collapses a volume mount that resolves to the filesystem root', async () => {
    const io = fakeIo({
      children: { '/Volumes': ['/Volumes/Macintosh HD', '/Volumes/CodeS'] },
      resolved: { '/Volumes/Macintosh HD': '/' }
    })
    await expect(collectRoots('darwin', io)).resolves.toEqual([
      { name: '/', path: '/' },
      { name: 'CodeS', path: '/Volumes/CodeS' }
    ])
  })

  it('includes the Linux mount parents a user picks directories from', async () => {
    const io = fakeIo({
      children: {
        '/media': ['/media/usb'],
        '/mnt': ['/mnt/data'],
        '/run/media': ['/run/media/me/disk']
      }
    })
    await expect(collectRoots('linux', io)).resolves.toEqual([
      { name: '/', path: '/' },
      { name: 'usb', path: '/media/usb' },
      { name: 'data', path: '/mnt/data' },
      { name: 'disk', path: '/run/media/me/disk' }
    ])
  })

  it('reports no Windows drive when no letter answers', async () => {
    await expect(collectRoots('win32', fakeIo())).resolves.toEqual([])
  })
})

describe('rootsFor', () => {
  it('reuses one enumeration inside the cache lifetime', async () => {
    resetRootCache()
    const io = fakeIo({ directories: [winRoot('C')] })
    await rootsFor('win32', io)
    await rootsFor('win32', io)
    expect(io.probes.isDirectory).toBe(26)
    resetRootCache()
  })

  it('re-enumerates after the cache is cleared', async () => {
    resetRootCache()
    const io = fakeIo({ directories: [winRoot('C')] })
    await rootsFor('win32', io)
    resetRootCache()
    await rootsFor('win32', io)
    expect(io.probes.isDirectory).toBe(52)
    resetRootCache()
  })

  it('does not cache an enumeration that lost a mount parent', async () => {
    resetRootCache()
    let failures = 1
    const io = {
      async isDirectory() {
        return false
      },
      async readDirectories() {
        if (failures > 0) {
          failures -= 1
          throw new Error('volume parent is busy')
        }
        return ['/Volumes/CodeS']
      },
      async realpath(path) {
        return path
      }
    }
    // The failed read yields no volume, but must not freeze that answer for the
    // whole cache lifetime: the next listing retries and finds the volume.
    await expect(rootsFor('darwin', io)).resolves.toEqual([{ name: '/', path: '/' }])
    await expect(rootsFor('darwin', io)).resolves.toEqual([
      { name: '/', path: '/' },
      { name: 'CodeS', path: '/Volumes/CodeS' }
    ])
    resetRootCache()
  })
})

describe('addRootShortcuts', () => {
  it('prepends the shortcuts and keeps every original row', async () => {
    const listing = await addRootShortcuts(homeListing, {
      platform: 'win32',
      roots: [
        { name: winRoot('C'), path: winRoot('C') },
        { name: winRoot('D'), path: winRoot('D') }
      ]
    })
    expect(listing.entries.map((entry) => entry.path)).toEqual([
      winRoot('D'),
      win('C:', 'Users', 'me', 'projects'),
      win('C:', 'Users', 'me', 'notes')
    ])
    expect(listing.path).toBe(win('C:', 'Users', 'me'))
    expect(listing.truncated).toBe(false)
  })

  it('returns the untouched listing when no root is reachable from it', async () => {
    const listing = await addRootShortcuts(homeListing, {
      platform: 'win32',
      roots: [{ name: winRoot('C'), path: winRoot('C') }]
    })
    expect(listing).toBe(homeListing)
  })

  it('leaves the listing intact when enumeration fails', async () => {
    const io = {
      async isDirectory() {
        throw new Error('device not ready')
      },
      async readDirectories() {
        throw new Error('device not ready')
      },
      async realpath() {
        throw new Error('device not ready')
      }
    }
    resetRootCache()
    const listing = await addRootShortcuts(homeListing, { platform: 'win32', io })
    expect(listing).toBe(homeListing)
    resetRootCache()
  })

  it('does not extend a listing whose caller already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const listing = await addRootShortcuts(homeListing, {
      platform: 'win32',
      roots: [{ name: winRoot('D'), path: winRoot('D') }],
      signal: controller.signal
    })
    expect(listing).toBe(homeListing)
  })
})

describe('decorateCapability', () => {
  const seams = {
    platform: 'win32',
    roots: [
      { name: winRoot('C'), path: winRoot('C') },
      { name: winRoot('D'), path: winRoot('D') }
    ]
  }

  it('extends the listing the backend returned without replacing its list logic', async () => {
    const { capability, calls } = browseCapability(homeListing)
    expect(decorateCapability(capability, seams)).toBe(true)
    const listing = await capability.list(undefined, undefined)
    expect(calls).toEqual([{ path: undefined, signal: undefined }])
    expect(listing.entries[0]).toEqual({ name: winRoot('D'), path: winRoot('D'), hidden: false })
    expect(listing.entries).toHaveLength(3)
  })

  it('decorates once, so a reload cannot wrap its own wrapper', async () => {
    const { capability } = browseCapability(homeListing)
    decorateCapability(capability, seams)
    const decorated = capability.list
    expect(decorateCapability(capability, seams)).toBe(false)
    expect(capability.list).toBe(decorated)
  })

  it('leaves a sealed capability alone instead of decorating it twice', () => {
    const capability = Object.freeze({
      kind: 'browse',
      list: async () => homeListing
    })
    expect(decorateCapability(capability, seams)).toBe(false)
  })

  it('leaves a native interaction and an unknown service alone', () => {
    const native = { kind: 'native', pick: async () => null }
    expect(decorateCapability(native, seams)).toBe(false)
    expect(decorateCapability(undefined, seams)).toBe(false)
    expect(decorateCapability({ kind: 'browse' }, seams)).toBe(false)
  })

  it('propagates the backend failure instead of masking it', async () => {
    const capability = {
      kind: 'browse',
      async list() {
        throw new Error('directory-unreadable')
      }
    }
    decorateCapability(capability, seams)
    await expect(capability.list(win('D:', 'missing'))).rejects.toThrow('directory-unreadable')
  })
})

describe('apply', () => {
  it('decorates the capability the composed picker serves', async () => {
    // A POSIX listing at the filesystem root: every root this host can enumerate
    // is that level or below it, so the decorated call returns the backend's own
    // listing object rather than a machine-dependent shortcut set.
    const rootListing = {
      path: '/',
      home: '/srv/me',
      crumbs: [{ name: '/', path: '/', hidden: false }],
      entries: [],
      truncated: false
    }
    const { capability } = browseCapability(rootListing)
    const original = capability.list
    apply({ directoryPicker: { capability: () => capability } })
    expect(capability.list).not.toBe(original)
    await expect(capability.list('/')).resolves.toBe(rootListing)
  })

  it('does nothing when the context has no picker service', () => {
    expect(() => apply({})).not.toThrow()
    expect(() => apply(undefined)).not.toThrow()
  })
})
