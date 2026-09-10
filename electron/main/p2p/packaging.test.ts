import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The peer helper is a separate Go binary copied in as an extra resource, so a
 * filter that does not match its directory silently ships an app that cannot
 * start the helper, with no build error.
 *
 * This has now broken twice through the same mechanism: electron-builder's
 * platform vocabulary is not Node's. ${os} expands to "mac", and ${platform}
 * expands to "win", while the helper build emits Node's process.platform values
 * (darwin, linux, win32) because that is what the main process looks up. macOS
 * and Linux happened to agree with ${platform}; Windows never did, so the
 * Windows package contained no helper at all and every P2P feature was dead
 * there.
 *
 * Each platform therefore names its own directory literally. A shared entry is
 * not used: platform extraResources merge with the top-level list rather than
 * replacing it, which let a same-architecture helper for another OS leak into
 * the package.
 */
describe('peer helper packaging', () => {
  const root = join(import.meta.dirname, '..', '..', '..')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const platforms = [
    { key: 'mac', target: 'darwin' },
    { key: 'win', target: 'win32' },
    { key: 'linux', target: 'linux' }
  ]

  it('gives every platform its own helper resource', () => {
    for (const { key, target } of platforms) {
      const entries = pkg.build[key]?.extraResources ?? []
      const helper = entries.find((entry: { from: string }) => entry.from === 'build/p2p')
      expect(helper, `${key} must ship the helper`).toBeDefined()
      expect(helper.to).toBe('p2p')
      // Literal platform name: no electron-builder variable matches Node's values.
      expect(helper.filter).toEqual([`${target}-\${arch}/**`])
    }
  })

  it('never resolves the platform through an electron-builder variable', () => {
    // ${platform} is win on Windows and ${os} is mac on macOS; both silently
    // match no directory the helper build produces.
    const serialized = JSON.stringify(platforms.map(({ key }) => pkg.build[key]?.extraResources))
    expect(serialized).not.toContain('${platform}')
    expect(serialized).not.toContain('${os}')
  })

  it('keeps no shared helper entry that would merge into every platform', () => {
    // A top-level entry is not replaced by the per-platform one; it is added to,
    // which is how a macOS helper reached a Windows arm64 package.
    const shared = (pkg.build.extraResources ?? []).filter(
      (entry: { to: string }) => entry.to === 'p2p'
    )
    expect(shared).toEqual([])
  })

  it('names every built helper directory the way the filters expect', () => {
    // A directory the filters cannot express would be dropped from the package.
    const built = readdirSync(join(root, 'build', 'p2p'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    expect(built.length).toBeGreaterThan(0)
    for (const name of built) {
      expect(name).toMatch(/^(darwin|linux|win32)-(arm64|x64)$/)
    }
  })
})
