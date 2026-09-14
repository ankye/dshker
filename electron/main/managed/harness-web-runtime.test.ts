import { stat, realpath } from 'node:fs/promises'
import nodePath from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  CoreHarnessLaunchRequest,
  CoreHarnessLaunchView,
  CoreHarnessRuntimePort
} from '../core/harness-runtime'
import { ManagedHarnessWebRuntimeSupervisor } from './harness-web-runtime'
import type { NodeExecutableRegistration } from './toolchain'

const REVISION = 'a'.repeat(40)
// The launch input is validated as an absolute, already-normalized path, and
// what that means is platform-specific: a Windows path is only absolute with a
// drive letter on it.
const WORKTREE = nodePath.resolve('worktrees', 'installation-1')

async function nodeRegistration(): Promise<NodeExecutableRegistration> {
  const canonicalPath = await realpath(process.execPath)
  const metadata = await stat(canonicalPath)
  return {
    requestedPath: canonicalPath,
    canonicalPath,
    fingerprint: {
      device: metadata.dev,
      inode: metadata.ino,
      mode: metadata.mode,
      size: metadata.size,
      modifiedAtMilliseconds: Math.trunc(metadata.mtimeMs),
      changedAtMilliseconds: Math.trunc(metadata.ctimeMs)
    },
    version: { major: 22, minor: 19, patch: 0, text: '22.19.0' }
  }
}

function coreLaunch(overrides: Partial<CoreHarnessLaunchView> = {}): CoreHarnessLaunchView {
  return {
    launchId: 'launch-1',
    subjectId: 'installation-1',
    state: 'running',
    directory: WORKTREE,
    port: { mode: 'auto' },
    diagnostics: {
      stdoutBytes: 12,
      stderrBytes: 3,
      stdoutTruncated: false,
      stderrTruncated: true,
      exitCode: undefined,
      exitSignal: undefined
    },
    ...overrides
  }
}

function fakeCore(
  answers: {
    status?: () => Promise<CoreHarnessLaunchView | undefined>
  } = {}
) {
  const calls: { method: string; value: unknown }[] = []
  const port: CoreHarnessRuntimePort = {
    start: (request: CoreHarnessLaunchRequest) => {
      calls.push({ method: 'start', value: request })
      return Promise.resolve(coreLaunch())
    },
    stop: (subjectId: string) => {
      calls.push({ method: 'stop', value: subjectId })
      return Promise.resolve(coreLaunch({ state: 'stopped' }))
    },
    status: (subjectId: string) => {
      calls.push({ method: 'status', value: subjectId })
      return answers.status?.() ?? Promise.resolve(coreLaunch({ state: 'stopped' }))
    },
    console: () => Promise.resolve({ entries: [], cursor: 0 }),
    portGet: () => Promise.resolve({ mode: 'auto' as const }),
    portSet: (_filePath: string, port: { mode: 'auto' } | { mode: 'fixed'; port: number }) =>
      Promise.resolve(port)
  }
  return { port, calls }
}

async function startInput() {
  return {
    installationId: 'installation-1',
    launchId: 'launch-1',
    node: await nodeRegistration(),
    worktreePath: WORKTREE,
    revision: REVISION
  }
}

describe('managed installation runtime supervisor', () => {
  it('runs the installation own Node against its own worktree through the core', async () => {
    const core = fakeCore()
    const input = await startInput()
    const view = await new ManagedHarnessWebRuntimeSupervisor({
      runtime: () => core.port
    }).start(input)

    expect(core.calls).toEqual([
      {
        method: 'start',
        value: {
          launchId: 'launch-1',
          subjectId: 'installation-1',
          directory: input.worktreePath,
          profile: 'node',
          nodeExecutable: input.node.canonicalPath,
          pnpmExecutable: '',
          pnpmPrefixArguments: [],
          pnpmResolutionError: '',
          pnpmCommandSearchPath: '',
          diagnosticsPatchPath: '',
          port: { mode: 'auto' },
          logPath: ''
        }
      }
    ])
    expect(view).toMatchObject({
      installationId: 'installation-1',
      launchId: 'launch-1',
      state: 'running',
      worktreePath: input.worktreePath,
      revision: REVISION,
      descriptorPath: undefined,
      diagnostics: { stdoutBytes: 12, stderrBytes: 3, stderrTruncated: true }
    })
  })

  it('reads the launch state the core reports rather than a cached guess', async () => {
    const core = fakeCore({ status: () => Promise.resolve(undefined) })
    const supervisor = new ManagedHarnessWebRuntimeSupervisor({ runtime: () => core.port })
    await expect(supervisor.launchFor('installation-1')).rejects.toMatchObject({
      code: 'runtime.not_found'
    })
    expect(core.calls).toEqual([{ method: 'status', value: 'installation-1' }])
  })

  it('refuses to supervise anything without the core', async () => {
    const supervisor = new ManagedHarnessWebRuntimeSupervisor()
    await expect(supervisor.stop('installation-1')).rejects.toMatchObject({
      code: 'runtime.child_unavailable'
    })
  })

  it('does not record a running installation when the core refuses the entry', async () => {
    const refusal = Object.assign(new Error('runtime.worktree_invalid'), {
      code: 'runtime.worktree_invalid'
    })
    const core = fakeCore()
    const supervisor = new ManagedHarnessWebRuntimeSupervisor({
      runtime: () => ({ ...core.port, start: () => Promise.reject(refusal) })
    })
    await expect(supervisor.start(await startInput())).rejects.toBe(refusal)
    expect(core.calls).toEqual([])
  })
})
