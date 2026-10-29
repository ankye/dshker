import { afterEach, describe, expect, it } from 'vitest'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreSupervisor, type CoreSupervisorOptions } from './supervisor'

// This suite must run with an explicitly built real core. The ordinary fixture
// executable cannot establish broker or independent-owner cleanup semantics.
describe.skipIf(!process.env.DSHKER_CORE_BINARY)('real core runtime-owner shutdown', () => {
  let root: string | undefined
  let options: CoreSupervisorOptions | undefined
  let supervisor: CoreSupervisor | undefined
  let pending: Socket | undefined

  afterEach(async () => {
    pending?.destroy()
    pending = undefined
    await supervisor?.close()
    supervisor = undefined
    if (root && options) {
      const retained = await readFile(join(options.stateRoot, 'runtime-owner', 'owner.json')).catch(
        () => undefined
      )
      if (retained) {
        // A failed regression may have killed the core while leaving its real
        // owner alive. Reconnect through the same exact production composition
        // to join it; never terminate an arbitrary PID or delete its record.
        const recovery = await CoreSupervisor.start(options, AbortSignal.timeout(30_000))
        await recovery.close()
      }
    }
    options = undefined
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it('joins its runtime owner after the broker exhausts its existing graceful budget', async () => {
    const source = process.env.DSHKER_CORE_BINARY
    if (!source) throw new Error('DSHKER_CORE_BINARY required')
    root = await realpath(await mkdtemp(join(tmpdir(), 'core-owner-shutdown-')))
    const target = `${process.platform}-${process.arch}`
    const directory = join(root, 'p2p', target)
    const name = process.platform === 'win32' ? 'dshkerd.exe' : 'dshkerd'
    await mkdir(directory, { recursive: true })
    await copyFile(source, join(directory, name))
    if (process.platform !== 'win32') await chmod(join(directory, name), 0o755)
    const bytes = await readFile(source)
    await writeFile(
      join(directory, 'dshkerd-manifest.json'),
      JSON.stringify({
        version: 1,
        target,
        file: name,
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
    )
    options = {
      resourcesRoot: root,
      stateRoot: join(root, 'state'),
      dataRoot: join(root, 'data'),
      isolatedProfileRoot: root,
      catalogRoot: join(root, 'catalog'),
      onUnavailable: () => undefined
    }
    supervisor = await CoreSupervisor.start(options, AbortSignal.timeout(30_000))
    const ownerPath = join(options.stateRoot, 'runtime-owner', 'owner.json')
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as {
      process: { pid: number }
      config: { executable: string; stateRoot: string }
    }
    expect(owner.config.executable).toBe(join(directory, name))
    expect(owner.config.stateRoot).toBe(options.stateRoot)
    expect(owner.process.pid).toBeGreaterThan(0)

    const descriptorPath = join(root, 'remote-peer.json')
    const broker = (await supervisor.call(
      'remote.broker_start',
      { descriptorPath, subjectId: 'subject_shutdown' },
      AbortSignal.timeout(5_000)
    )) as { port: number }
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as { secret: string }
    pending = connect({ host: '127.0.0.1', port: broker.port })
    // A partial request body holds a real active HTTP connection while Go's
    // response path tries to drain it. Nothing waits on an invented test hook.
    pending.on('error', () => undefined)
    await new Promise<void>((resolve, reject) => {
      pending!.once('error', reject)
      pending!.once('connect', () => {
        pending!.write(
          `POST /v1/runtime/connect HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${descriptor.secret}\r\nContent-Length: 1024\r\n\r\n{`,
          () => resolve()
        )
      })
    })
    // The second accepted connection is a real server barrier: Serve tracks
    // each accepted connection before accepting the next one. Its 404 proves
    // the earlier still-incomplete connection belongs to this broker.
    const barrierStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = get(`http://127.0.0.1:${broker.port}/shutdown-accept-barrier`, (response) => {
        response.resume()
        response.once('end', () => resolve(response.statusCode))
      })
      request.once('error', reject)
      request.setTimeout(5_000, () => request.destroy(new Error('broker barrier timeout')))
    })
    expect(barrierStatus).toBe(404)

    await supervisor.close()
    expect(await readFile(ownerPath).catch(() => undefined)).toBeUndefined()
    expect(() => process.kill(supervisor!.pid, 0)).toThrow()
    // Shutdown's receipt includes joining the exact owner, not only losing the
    // supervised core. The record must be removed before close reports success.
    expect(() => process.kill(owner.process.pid, 0)).toThrow()
  })
})
