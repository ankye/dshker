import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The peer helper is a separate Go binary copied in as an extra resource, so a
 * filter that does not match its directory silently ships an app that cannot
 * start the helper. That failed at runtime as p2p.helper_resource_unavailable
 * with no build error: electron-builder expands ${os} to "mac" on macOS while
 * the build emits "darwin-arm64". Linux only worked because ${os} happened to
 * equal "linux".
 */
describe('peer helper packaging', () => {
  const root = join(import.meta.dirname, '..', '..', '..')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const resource = pkg.build.extraResources.find(
    (entry: { from: string }) => entry.from === 'build/p2p'
  )

  it('ships the helper under the resource path the main process reads', () => {
    expect(resource).toBeDefined()
    expect(resource.to).toBe('p2p')
  })

  it('filters by the platform name the helper build actually produces', () => {
    // tools/build-peer-helper.mjs names directories with Node's platform values
    // (darwin, linux, win32). ${os} is a different vocabulary and matches none.
    expect(resource.filter).toEqual(['${platform}-${arch}/**'])
    expect(JSON.stringify(resource.filter)).not.toContain('${os}')
  })

  it('names every built helper directory the way the filter expects', () => {
    // A directory the filter cannot express would be dropped from the package.
    const built = readdirSync(join(root, 'build', 'p2p'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    expect(built.length).toBeGreaterThan(0)
    for (const name of built) {
      expect(name).toMatch(/^(darwin|linux|win32)-(arm64|x64)$/)
    }
  })
})
