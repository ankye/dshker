import { EventEmitter } from 'node:events'
import type { Stats } from 'node:fs'
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertRegisteredNodeExecutable,
  createToolchainExecutionEnvironment,
  PNPM_PROBE_CONFIGURATION_FILE_NAME,
  preflightCheckoutToolchain,
  registerNodeExecutable,
  ToolchainCommandRunner
} from './process'
import { parseToolchainVersion } from './semver'
import type {
  NodeExecutableRegistration,
  PnpmExecutableRegistration,
  PnpmProbeContext,
  ToolchainProcessContext
} from './types'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  )
})

describe('explicit Node and pnpm tool probes', () => {
  it('registers the selected Node file through a real direct version probe', async () => {
    const registration = await registerNodeExecutable(
      process.execPath,
      processContext(process.cwd())
    )

    expect(registration.canonicalPath).toBe(await realpath(process.execPath))
    expect(registration.version.text).toBe(process.version.slice(1))
  })

  it('uses a direct Node executable with an empty explicit environment and no shell', async () => {
    const child = fakeChild()
    const spawnProcess = vi.fn(() => child as never)
    const runner = new ToolchainCommandRunner(spawnProcess)
    const probe = runner.probeNodeVersion(process.execPath, processContext(process.cwd()))

    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce())
    child.stdout.end('v22.19.0\n')
    child.stderr.end()
    child.emit('close', 0, null)

    await expect(probe).resolves.toEqual(parseToolchainVersion('22.19.0'))
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ['--version'],
      expect.objectContaining({ shell: false, env: {}, stdio: ['ignore', 'pipe', 'pipe'] })
    )
  })

  it('launches a pnpm script through the explicitly registered Node and isolated empty config', async () => {
    const isolation = await createPnpmIsolation()
    const node = await nodeRegistration()
    const child = fakeChild()
    const spawnProcess = vi.fn(() => child as never)
    const runner = new ToolchainCommandRunner(spawnProcess)
    const probe = runner.probePnpmVersion(
      '/registered/pnpm-script.mjs',
      { kind: 'node-script', node },
      pnpmContext(isolation)
    )

    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce())
    child.stdout.end('11.7.0\n')
    child.stderr.end()
    child.emit('close', 0, null)

    await expect(probe).resolves.toEqual(parseToolchainVersion('11.7.0'))
    expect(spawnProcess).toHaveBeenCalledWith(
      node.canonicalPath,
      [
        '/registered/pnpm-script.mjs',
        '--config-dir',
        isolation.directoryPath,
        '--dir',
        isolation.directoryPath,
        '--userconfig',
        isolation.configurationFilePath,
        '--globalconfig',
        isolation.configurationFilePath,
        '--ignore-workspace',
        '--version'
      ],
      expect.objectContaining({ shell: false, env: {}, cwd: isolation.directoryPath })
    )
  })

  it('rejects PATH and an extra pnpm configuration file before starting a probe', async () => {
    const invalidContext: ToolchainProcessContext = {
      ...processContext(process.cwd()),
      environment: { PATH: '/unsafe' }
    }
    await expect(
      new ToolchainCommandRunner().probeNodeVersion(process.execPath, invalidContext)
    ).rejects.toMatchObject({ code: 'toolchain.probe_context_invalid' })

    const isolation = await createPnpmIsolation()
    await writeFile(nodePath.join(isolation.directoryPath, '.npmrc'), 'unsafe=true\n')
    await expect(
      new ToolchainCommandRunner().probePnpmVersion(
        process.execPath,
        { kind: 'native' },
        pnpmContext(isolation)
      )
    ).rejects.toMatchObject({ code: 'toolchain.probe_isolation_invalid' })
  })

  it('blocks an executable whose registered file fingerprint no longer matches', async () => {
    const registration = await nodeRegistration()

    await expect(
      assertRegisteredNodeExecutable({
        ...registration,
        fingerprint: { ...registration.fingerprint, size: registration.fingerprint.size + 1 }
      })
    ).rejects.toMatchObject({ code: 'toolchain.executable_changed' })
  })

  it('requires both the checkout Node range and exact pnpm declaration', async () => {
    const node = await nodeRegistration('22.19.0')
    const pnpm = await pnpmRegistration('11.7.0')
    const requirements = {
      worktreePath: '/selected/worktree',
      packageManifestPath: '/selected/worktree/package.json',
      nodeRange: {
        text: '^22.19.0',
        alternatives: [
          [
            {
              operator: '^' as const,
              version: parseToolchainVersion('22.19.0'),
              precision: 3 as const
            }
          ]
        ]
      },
      pnpm: { text: 'pnpm@11.7.0', version: parseToolchainVersion('11.7.0') }
    }

    await expect(preflightCheckoutToolchain(requirements, node, pnpm)).resolves.toBeUndefined()
    await expect(
      preflightCheckoutToolchain(requirements, node, {
        ...pnpm,
        version: parseToolchainVersion('11.7.1')
      })
    ).rejects.toMatchObject({ code: 'toolchain.pnpm_version_mismatch' })
  })
})

function processContext(workingDirectory: string): ToolchainProcessContext {
  return {
    workingDirectory,
    environment: createToolchainExecutionEnvironment({
      platform: process.platform,
      ...(process.platform === 'win32'
        ? {
            systemRoot: windowsEnvironment('SYSTEMROOT'),
            windir: windowsEnvironment('WINDIR'),
            comspec: windowsEnvironment('COMSPEC'),
            pathExt: windowsEnvironment('PATHEXT')
          }
        : {})
    }),
    timeoutMilliseconds: 1_000,
    maximumOutputBytes: 4_096
  }
}

function pnpmContext(isolation: PnpmIsolation): PnpmProbeContext {
  return {
    ...processContext(isolation.directoryPath),
    configurationFilePath: isolation.configurationFilePath
  }
}

async function createPnpmIsolation(): Promise<PnpmIsolation> {
  const directoryPath = await realpath(await mkdtemp(nodePath.join(tmpdir(), 'dsh-pnpm-probe-')))
  temporaryPaths.push(directoryPath)
  const configurationFilePath = nodePath.join(directoryPath, PNPM_PROBE_CONFIGURATION_FILE_NAME)
  await writeFile(configurationFilePath, '')
  return { directoryPath, configurationFilePath }
}

async function nodeRegistration(version = '22.19.0'): Promise<NodeExecutableRegistration> {
  const canonicalPath = await realpath(process.execPath)
  const metadata = await stat(canonicalPath)
  return {
    requestedPath: canonicalPath,
    canonicalPath,
    fingerprint: fingerprintFromStat(metadata),
    version: parseToolchainVersion(version)
  }
}

async function pnpmRegistration(version: string): Promise<PnpmExecutableRegistration> {
  const node = await nodeRegistration()
  return {
    ...node,
    launcher: { kind: 'node-script', node },
    version: parseToolchainVersion(version)
  }
}

function fingerprintFromStat(metadata: Stats) {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    size: metadata.size,
    modifiedAtMilliseconds: metadata.mtimeMs,
    changedAtMilliseconds: metadata.ctimeMs
  }
}

function windowsEnvironment(name: string): string | undefined {
  return Object.entries(process.env).find(([key]) => key.toUpperCase() === name)?.[1]
}

function fakeChild(): EventEmitter & {
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
} {
  const child = new EventEmitter() as EventEmitter & {
    readonly stdout: PassThrough
    readonly stderr: PassThrough
    kill: ReturnType<typeof vi.fn>
  }
  Object.defineProperties(child, {
    stdout: { value: new PassThrough() },
    stderr: { value: new PassThrough() },
    kill: {
      value: vi.fn(() => {
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'))
        return true
      })
    }
  })
  return child
}

interface PnpmIsolation {
  readonly directoryPath: string
  readonly configurationFilePath: string
}
