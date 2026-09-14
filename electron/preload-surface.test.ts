import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// The renderer's whole capability surface, recorded once and pinned from then on.
//
// Task 1.4 of go-owned-headless-core asked for the current renderer-visible
// operations and their projections to be written down so the proxy that replaced
// their implementation could be checked against them, and 7.2 asks for the same
// surface to be byte-for-byte unchanged at the end. This test is both halves: the
// golden file is the record, and the assertion is the check. Re-record it only
// when the renderer contract itself changes, with PRELOAD_SURFACE_UPDATE=1.
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), exposed: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcRenderer: { invoke: mocks.invoke },
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => mocks.exposed.set(name, api)
  }
}))

const goldenPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'preload-surface.golden.json'
)

/**
 * Collects every named member of one exposed surface as a dotted path, with a
 * trailing () for a method. A grouped object is descended into rather than
 * recorded as one name, because the renderer calls the members, not the group.
 */
function surfaceOf(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [`${prefix}${String(value)}`]
  const names: string[] = []
  for (const key of Object.keys(value)) {
    const member = (value as Record<string, unknown>)[key]
    if (typeof member === 'function') names.push(`${prefix}${key}()`)
    else if (typeof member === 'object' && member !== null && !Array.isArray(member)) {
      names.push(...surfaceOf(member, `${prefix}${key}.`))
    } else names.push(`${prefix}${key}=${JSON.stringify(member)}`)
  }
  return names.sort()
}

describe('frozen renderer surface', () => {
  it('exposes exactly the recorded operations and nothing else', async () => {
    await import('./preload')
    expect(mocks.exposed.size).toBe(1)
    const desktop = mocks.exposed.get('dshLauncher') as { apiVersion: unknown }
    const surface = {
      apiVersion: desktop.apiVersion,
      operations: surfaceOf(desktop)
    }

    if (process.env.PRELOAD_SURFACE_UPDATE === '1') {
      await writeFile(goldenPath, `${JSON.stringify(surface, null, 2)}\n`)
      return
    }

    const recorded = JSON.parse(await readFile(goldenPath, 'utf8'))
    expect(surface).toEqual(recorded)
  })

  it('keeps every exposed operation a named function rather than a channel', async () => {
    await import('./preload')
    const desktop = mocks.exposed.get('dshLauncher') as Record<string, unknown>
    // A group is a plain object of methods; the bridge never carries an
    // invoker, a channel name, or raw ipcRenderer access to the renderer.
    expect(desktop).not.toHaveProperty('invoke')
    expect(desktop).not.toHaveProperty('ipcRenderer')
    expect(desktop).not.toHaveProperty('send')
    for (const key of Object.keys(desktop)) {
      const member = desktop[key]
      if (typeof member === 'object' && member !== null && key !== 'apiVersion') {
        for (const name of Object.keys(member)) {
          expect(typeof (member as Record<string, unknown>)[name]).toBe('function')
        }
      }
    }
  })
})
