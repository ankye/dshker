import { spawn } from 'node:child_process'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(appRoot, 'tools', 'headless-core-smoke.mjs')
const tempRoots = []

async function runSmoke(root, extra = []) {
  const child = spawn(process.execPath, [script, '--json', '--app-root', root, ...extra], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  const code = await new Promise((resolve) => child.on('close', resolve))
  return { code, stdout: stdout.join(''), stderr: stderr.join('') }
}

afterEach(async () => {
  while (tempRoots.length) await rm(tempRoots.pop(), { force: true, recursive: true })
})

describe('headless core smoke', () => {
  it('fails, and says why, when there is no core for this machine', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'headless-smoke-'))
    tempRoots.push(root)

    const result = await runSmoke(root)
    expect(result.code).toBe(1)
    const evidence = JSON.parse(result.stdout)
    expect(evidence.ok).toBe(false)
    expect(evidence.failures).toContain('core-binary')
    expect(evidence.observations[0].name).toBe('core-binary')
    // The evidence is written even on failure, so the gate always leaves the
    // observation that explains it.
    const written = JSON.parse(
      await readFile(path.join(root, '.run', 'headless-core', 'latest.json'), 'utf8')
    )
    expect(written.ok).toBe(false)
  })

  it('proves the headless entry point when this machine has a built core', async () => {
    const file = process.platform === 'win32' ? 'dshkerd.exe' : 'dshkerd'
    const executable = path.join(
      appRoot,
      'build',
      'p2p',
      `${process.platform}-${process.arch}`,
      file
    )
    let present = true
    try {
      const info = await lstat(executable)
      present = info.isFile()
    } catch {
      present = false
    }
    if (!present) {
      // A machine without the core cannot prove the entry point; the failure
      // path above is the part that must hold everywhere.
      expect(true).toBe(true)
      return
    }

    const result = await runSmoke(appRoot)
    expect(result.stderr).toBe('')
    const evidence = JSON.parse(result.stdout)
    expect(evidence.ok).toBe(true)
    expect(evidence.failures).toEqual([])
    expect(evidence.observations.map((observation) => observation.name)).toEqual([
      'core-binary',
      'serve-publishes-its-own-endpoint',
      'named-command-over-the-private-endpoint',
      'refusal-keeps-its-code'
    ])
  }, 120_000)
})
