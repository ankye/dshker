import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const script = path.resolve(import.meta.dirname, 'p2p-preflight.mjs')

/** Runs the preflight tool and returns its parsed JSON plus exit code. */
async function run(args) {
  try {
    const { stdout } = await execFileAsync('node', [script, '--json', ...args])
    return { code: 0, report: JSON.parse(stdout) }
  } catch (error) {
    return { code: error.code ?? 1, report: JSON.parse(error.stdout) }
  }
}

function check(report, name) {
  return report.checks.find((entry) => entry.name === name)
}

const roots = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('p2p preflight tool', () => {
  it('always reports the helper check even with no arguments', async () => {
    const { report } = await run([])
    expect(check(report, 'peer-helper')).toBeDefined()
    expect(report.platform).toBe(process.platform)
  })

  it('rejects a plain http origin because the app refuses it', async () => {
    const { code, report } = await run(['--https', 'http://example.com'])
    expect(check(report, 'https').ok).toBe(false)
    expect(check(report, 'https').detail).toMatch(/https:/)
    expect(code).toBe(1)
  })

  it('rejects a plain ws signalling url', async () => {
    const { report } = await run(['--wss', 'ws://example.com'])
    expect(check(report, 'wss').ok).toBe(false)
    expect(check(report, 'wss').detail).toMatch(/wss:/)
  })

  it('rejects a malformed stun address instead of guessing a port', async () => {
    const { report } = await run(['--stun', 'not-an-address'])
    expect(check(report, 'stun').ok).toBe(false)
    expect(check(report, 'stun').detail).toMatch(/host:port/)
  })

  it('rejects an out-of-range stun port', async () => {
    const { report } = await run(['--stun', 'example.test:70000'])
    expect(check(report, 'stun').ok).toBe(false)
  })

  it('reports a dead UDP target as unreachable rather than assuming it works', async () => {
    const { code, report } = await run(['--stun', '127.0.0.1:19999'])
    const stun = check(report, 'stun')
    expect(stun.ok).toBe(false)
    // The message must name the real consequence, not just "failed".
    expect(stun.detail).toMatch(/no relay/i)
    expect(code).toBe(1)
  })

  it('exits non-zero when any check fails', async () => {
    const { code, report } = await run(['--https', 'http://example.com'])
    expect(report.ok).toBe(false)
    expect(code).toBe(1)
  })

  it('fails loudly on an unknown argument instead of ignoring it', async () => {
    await expect(execFileAsync('node', [script, '--bogus'])).rejects.toThrow()
  })

  it('requires a value after an endpoint flag', async () => {
    await expect(execFileAsync('node', [script, '--stun', '--json'])).rejects.toThrow()
  })
})
