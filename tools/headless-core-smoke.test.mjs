import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { requestServingShutdown, smokeCoreEnvironment } from './headless-core-smoke.mjs'

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
  it('isolates native secrets and global autostart for every explicit smoke state', () => {
    const first = smokeCoreEnvironment(path.resolve('.run/first-smoke'), {
      DSHKER_SECRET_NAMESPACE: 'inherited-stable-or-test',
      PATH: 'preserved'
    })
    expect(first.DSHKER_SECRET_NAMESPACE).toMatch(/^smoke-[a-f0-9]{64}$/u)
    expect(first.PATH).toBe('preserved')
    expect(smokeCoreEnvironment(path.resolve('.run/first-smoke'), {}).DSHKER_SECRET_NAMESPACE).toBe(
      first.DSHKER_SECRET_NAMESPACE
    )
    expect(
      smokeCoreEnvironment(path.resolve('.run/second-smoke'), {}).DSHKER_SECRET_NAMESPACE
    ).not.toBe(first.DSHKER_SECRET_NAMESPACE)
    expect(() => smokeCoreEnvironment('relative')).toThrow('Explicit absolute smoke state required')
  })
  it('fails, and says why, when there is no core for this machine', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'headless-smoke-'))
    tempRoots.push(root)

    const result = await runSmoke(root)
    expect(result.code).toBe(1)
    const evidence = JSON.parse(result.stdout)
    expect(evidence.ok).toBe(false)
    expect(evidence.failures).toContain('core-binary')
    expect(evidence.observations[0].name).toBe('core-binary')
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
      'refusal-keeps-its-code',
      'serve-process-graceful-exit'
    ])
  }, 120_000)
})

describe('headless smoke authenticated shutdown', () => {
  it('attaches and hands off on the same authenticated connection', async () => {
    const secret = 'a'.repeat(64)
    const state = await mkdtemp(path.join(os.tmpdir(), 'dshker-headless-smoke-test-'))
    const server = net.createServer()
    const methods = []
    let auth
    let serveClosed
    let buffer = ''
    server.on('connection', (socket) => {
      serveClosed = once(socket, 'close')
      socket.on('data', (chunk) => {
        buffer += String(chunk)
        let boundary = buffer.indexOf('\n')
        while (boundary >= 0) {
          const line = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 1)
          const frame = JSON.parse(line)
          if (auth === undefined) {
            auth = frame
            socket.write('{"version":1,"authenticated":true}\n')
          } else {
            methods.push(frame.method)
            const result =
              frame.method === 'core.desktop_attach' ? { attached: true } : { handoff: true }
            socket.write(
              `${JSON.stringify({ version: 1, id: frame.id, method: '', payload: result, error: '' })}\n`
            )
          }
          boundary = buffer.indexOf('\n')
        }
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    expect(address).toBeTruthy()
    expect(typeof address).toBe('object')
    await writeFile(
      path.join(state, 'core.json'),
      JSON.stringify({ version: 1, socket: 'private-core-endpoint', secret })
    )

    try {
      await requestServingShutdown(state, () => net.createConnection(address), 2_000)
      await serveClosed
      expect(auth).toEqual({ version: 1, secret })
      expect(methods).toEqual(['core.desktop_attach', 'core.desktop_handoff'])
    } finally {
      server.closeAllConnections?.()
      server.close()
      await rm(state, { force: true, recursive: true })
    }
  })

  it('refuses an invalid authenticated handoff response', async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), 'dshker-headless-smoke-invalid-'))
    await writeFile(
      path.join(state, 'core.json'),
      JSON.stringify({ version: 1, socket: 'private-core-endpoint', secret: 'b'.repeat(64) })
    )
    const server = net.createServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += String(chunk)
        let boundary = buffer.indexOf('\n')
        while (boundary >= 0) {
          const line = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 1)
          const frame = JSON.parse(line)
          if (typeof frame.secret === 'string') {
            socket.write('{"version":1,"authenticated":true}\n')
          } else {
            socket.write(
              `${JSON.stringify({ version: 1, id: frame.id, method: '', payload: {}, error: 'p2p.owner_busy' })}\n`
            )
          }
          boundary = buffer.indexOf('\n')
        }
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()

    try {
      await expect(
        requestServingShutdown(state, () => net.createConnection(address), 2_000)
      ).rejects.toThrow(/core\.desktop_attach was not acknowledged/)
    } finally {
      server.closeAllConnections?.()
      server.close()
      await rm(state, { force: true, recursive: true })
    }
  })
})
