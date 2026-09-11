import { afterEach, describe, expect, it } from 'vitest'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreSupervisor } from './supervisor'
import { PeerHelperError } from '../p2p/wire'

const target = process.platform + '-' + process.arch
const coreName = () => (process.platform === 'win32' ? 'dshkerd.exe' : 'dshkerd')

interface Launch {
  readonly resourcesRoot: string
  readonly dataRoot: string
}

// On win32 the fake executable cannot be a script, so the suite uses the real
// dshkerd binary when DSHKER_CORE_BINARY points at one; otherwise it skips.
describe.skipIf(process.platform === 'win32' && !process.env.DSHKER_CORE_BINARY)(
  'core supervisor',
  () => {
    const supervisors: CoreSupervisor[] = []
    const resources: string[] = []

    afterEach(async () => {
      delete process.env.FAKE_CORE_ARGV_OUT
      await Promise.all(
        supervisors.splice(0).map((supervisor) => supervisor.close().catch(() => undefined))
      )
      await Promise.all(
        resources.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))
      )
    })

    async function harness(): Promise<Launch> {
      const resourcesRoot = await mkdtemp(join(tmpdir(), 'core-res-'))
      const dataRoot = await mkdtemp(join(tmpdir(), 'core-data-'))
      resources.push(resourcesRoot)
      const directory = join(resourcesRoot, 'p2p', target)
      await mkdir(directory, { recursive: true })
      const name = coreName()
      let bytes: Buffer
      if (process.platform === 'win32') {
        const real = process.env.DSHKER_CORE_BINARY
        if (!real) throw new Error('DSHKER_CORE_BINARY required on win32')
        bytes = await readFile(real)
        await copyFile(real, join(directory, name))
      } else {
        const fixture = join(process.cwd(), 'electron/main/core/fixtures/fake-core.mjs')
        bytes = await readFile(fixture)
        await writeFile(join(directory, name), bytes)
        await chmod(join(directory, name), 0o755)
      }
      const manifest = {
        version: 1,
        target,
        file: name,
        sha256: createHash('sha256').update(bytes).digest('hex')
      }
      await writeFile(join(directory, 'dshkerd-manifest.json'), JSON.stringify(manifest) + '\n')
      return { resourcesRoot, dataRoot }
    }

    function launch(meta: Launch, argvOut?: string) {
      if (argvOut) process.env.FAKE_CORE_ARGV_OUT = argvOut
      let capture: (error: PeerHelperError) => void = () => undefined
      const unavailable = new Promise<PeerHelperError>((resolve) => {
        capture = resolve
      })
      const supervisor = CoreSupervisor.start(
        {
          resourcesRoot: meta.resourcesRoot,
          dataRoot: meta.dataRoot,
          onUnavailable: capture
        },
        AbortSignal.timeout(30_000)
      )
      return { supervisor, unavailable }
    }

    it('boots a real child, proves core.version, and exits with the shell', async () => {
      const meta = await harness()
      const { supervisor: started } = launch(meta)
      const supervisor = await started
      supervisors.push(supervisor)
      const version = await supervisor.rpc.call('core.version', {}, AbortSignal.timeout(5_000))
      expect(version).toMatchObject({ version: 1, methodTableVersion: 1 })
      // A deliberate close surfaces unavailable through the same channel: the
      // core no longer serves. The call that matters is that close settles and
      // the pid is gone (covered by the --data test).
      await supervisor.close()
    })

    it('passes --data with the data root and leaves no process behind', async () => {
      const meta = await harness()
      const argvOut = await mkdtemp(join(tmpdir(), 'core-argv-'))
      const { supervisor: started } = launch(meta, argvOut)
      const supervisor = await started
      supervisors.push(supervisor)
      // The fixture records argv; the real dshkerd binary proves --data by
      // serving, which the boot test already asserts on win32.
      if (process.platform !== 'win32') {
        const argv = JSON.parse(
          String(await readFile(join(argvOut, 'argv.json'), 'utf8'))
        ) as string[]
        expect(argv).toEqual(['--data', meta.dataRoot])
      }
      await supervisor.close()
      await expect(processAlive(supervisor.pid)).resolves.toBe(false)
    })

    it('terminates the core child on SIGTERM with no survivor', async () => {
      const meta = await harness()
      const { supervisor: started, unavailable } = launch(meta)
      const supervisor = await started
      supervisors.push(supervisor)
      process.kill(supervisor.pid, 'SIGTERM')
      const error = await unavailable
      expect(error.code).toBe('p2p.helper_unavailable')
      await expect(processAlive(supervisor.pid)).resolves.toBe(false)
    })

    it('reports unavailable when the core crashes', async () => {
      const meta = await harness()
      const argvOut = await mkdtemp(join(tmpdir(), 'core-argv-'))
      const { supervisor: started, unavailable } = launch(meta, argvOut)
      const supervisor = await started
      supervisors.push(supervisor)
      process.kill(supervisor.pid, 'SIGKILL')
      const error = await unavailable
      expect(error.code).toBe('p2p.helper_unavailable')
    })

    it('refuses a tampered manifest', async () => {
      const meta = await harness()
      const manifestPath = join(meta.resourcesRoot, 'p2p', target, 'dshkerd-manifest.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { sha256: string }
      manifest.sha256 = '0'.repeat(64)
      await writeFile(manifestPath, JSON.stringify(manifest) + '\n')
      await expect(launch(meta).supervisor).rejects.toThrow('p2p.helper_integrity_failed')
    })

    it('refuses when the core is not packaged', async () => {
      const dataRoot = await mkdtemp(join(tmpdir(), 'core-data-'))
      await expect(
        CoreSupervisor.start(
          { resourcesRoot: join(dataRoot, 'absent'), dataRoot, onUnavailable: () => undefined },
          AbortSignal.timeout(10_000)
        )
      ).rejects.toThrow('p2p.helper_resource_unavailable')
      await rm(dataRoot, { recursive: true, force: true })
    })

    it('refuses a data root that is not a directory', async () => {
      const meta = await harness()
      const blocker = join(meta.dataRoot, 'blocker')
      await writeFile(blocker, 'x')
      await expect(
        CoreSupervisor.start(
          { resourcesRoot: meta.resourcesRoot, dataRoot: blocker, onUnavailable: () => undefined },
          AbortSignal.timeout(10_000)
        )
      ).rejects.toThrow('p2p.invalid_arguments')
    })
  }
)

async function processAlive(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      process.kill(pid, 0)
    } catch {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}
