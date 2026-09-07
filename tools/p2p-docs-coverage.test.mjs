import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const appRoot = path.resolve(import.meta.dirname, '..')

/**
 * Guards the user-facing troubleshooting docs against silently going stale.
 *
 * Every error code the renderer can surface must be explained somewhere a user
 * can find it. Without this check, adding a code leaves the user with a bare
 * identifier and no guidance.
 */
async function userFacingCodes() {
  const source = await readFile(path.join(appRoot, 'src/shared/p2p-management.ts'), 'utf8')
  return [...new Set([...source.matchAll(/'(p2p\.[a-z_]+)'/g)].map((match) => match[1]))]
}

describe('P2P troubleshooting documentation', () => {
  it('explains every user-facing error code in both languages', async () => {
    const codes = await userFacingCodes()
    expect(codes.length).toBeGreaterThan(50)
    for (const file of ['docs/p2p-connections.md', 'docs/p2p-connections.zh-CN.md']) {
      const doc = await readFile(path.join(appRoot, file), 'utf8')
      const missing = codes.filter((code) => !doc.includes(code))
      expect(missing, `${file} does not document: ${missing.join(', ')}`).toEqual([])
    }
  })

  it('states the no-relay limit rather than implying every network works', async () => {
    for (const file of ['docs/p2p-connections.md', 'docs/p2p-connections.zh-CN.md']) {
      const doc = await readFile(path.join(appRoot, file), 'utf8')
      expect(doc).toMatch(/direct_unavailable/)
      expect(doc.toLowerCase()).toMatch(/no relay|不使用中继/)
    }
  })

  it('says an installer build is not a release', async () => {
    const en = await readFile(path.join(appRoot, 'docs/p2p-connections.md'), 'utf8')
    const zh = await readFile(path.join(appRoot, 'docs/p2p-connections.zh-CN.md'), 'utf8')
    expect(en).toMatch(/not a successful release/i)
    expect(zh).toMatch(/不等于发布成功/)
  })

  it('keeps authorized roots distinct from a DSH sandbox', async () => {
    const en = await readFile(path.join(appRoot, 'docs/p2p-connections.md'), 'utf8')
    const zh = await readFile(path.join(appRoot, 'docs/p2p-connections.zh-CN.md'), 'utf8')
    // The docs express this as "It is not: - A sandbox around DSH".
    expect(en.toLowerCase()).toMatch(/sandbox around dsh/)
    expect(en).toMatch(/only (limit|constrain) the folder picker/)
    expect(zh).toMatch(/沙箱/)
    expect(zh).toMatch(/只限制本应用/)
  })

  it('tells the user a lost connection is not a stopped task', async () => {
    const en = await readFile(path.join(appRoot, 'docs/p2p-connections.md'), 'utf8')
    const zh = await readFile(path.join(appRoot, 'docs/p2p-connections.zh-CN.md'), 'utf8')
    expect(en.toLowerCase()).toMatch(/never.*(retri|resubmit)/)
    expect(zh).toMatch(/绝不.*自动重试|不会自动重试/)
  })
})
