// @vitest-environment node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createPeerChannel, peerPipeName, removePeerChannel } from './private-channel'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('private helper channel ownership', () => {
  it('matches the exact Go Windows pipe prefix and rejects arbitrary suffixes', () => {
    const nonce = 'a'.repeat(32)
    const actual = peerPipeName(nonce)
    expect([...actual.slice(0, 9)].map((value) => value.charCodeAt(0))).toEqual([
      92, 92, 46, 92, 112, 105, 112, 101, 92
    ])
    expect(actual.slice(9)).toBe('dshker-peer-' + nonce)
    for (const value of ['', 'a'.repeat(31), 'a'.repeat(33), '../other', 'A'.repeat(32)])
      expect(() => peerPipeName(value)).toThrow('p2p.invalid_socket')
  })

  // macOS and Linux both use the owned Unix-socket directory, so this runs on
  // both; Windows uses a named pipe (covered by peerPipeName) and is skipped.
  it.skipIf(process.platform === 'win32')(
    'removes a crashed process channel and only its owned directory',
    async () => {
      const channel = await createPeerChannel()
      if (channel.directory) roots.push(channel.directory)
      const child = spawn(
        process.execPath,
        [
          '-e',
          'require("node:net").createServer().listen(process.argv[1], () => process.send("ready"))',
          channel.path
        ],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
      )
      const exited = once(child, 'exit')
      try {
        const ready = await once(child, 'message', { signal: AbortSignal.timeout(5000) })
        expect(ready).toEqual(['ready', undefined])
        if (channel.directory) {
          expect((await lstat(channel.directory)).mode & 0o777).toBe(0o700)
          expect((await lstat(channel.path)).isSocket()).toBe(true)
        }
        child.kill('SIGKILL')
        await exited
        if (channel.directory) {
          await removePeerChannel(channel.directory)
          await expect(lstat(channel.directory)).rejects.toMatchObject({ code: 'ENOENT' })
        }
        const socket = connect(channel.path)
        try {
          const [error] = await once(socket, 'error')
          expect(error.code).toMatch(/ENOENT|ECONNREFUSED/)
        } finally {
          socket.destroy()
        }
      } finally {
        child.kill('SIGKILL')
        await exited
      }
    }
  )

  it('refuses substituted regular files and preserves their bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'peer-channel-test-'))
    roots.push(directory)
    const path = join(directory, 'peer.sock')
    await writeFile(path, 'not a socket')
    await expect(removePeerChannel(directory)).rejects.toMatchObject({
      code: 'p2p.helper_cleanup_failed'
    })
    expect(await readFile(path, 'utf8')).toBe('not a socket')
  })

  it('does not recursively remove unexpected files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'peer-channel-test-'))
    roots.push(directory)
    await writeFile(join(directory, 'unrelated'), 'preserve')
    await expect(removePeerChannel(directory)).rejects.toMatchObject({
      code: 'p2p.helper_cleanup_failed'
    })
    expect(await readdir(directory)).toEqual(['unrelated'])
    expect(await readFile(join(directory, 'unrelated'), 'utf8')).toBe('preserve')
  })
})
