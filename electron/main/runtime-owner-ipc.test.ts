import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_IPC_CHANNELS } from '../../src/shared/contracts'
import { CoreHarnessRuntime, type CoreHarnessLaunchRequest } from './core/harness-runtime'
import { registerIpc, type LauncherIpcOptions } from './ipc'
import { PeerHelperError } from './p2p/wire'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  trusted: true
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  shell: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipc.handlers.set(channel, handler)
    }
  }
}))
vi.mock('./security', () => ({ isTrustedRenderer: () => ipc.trusted }))
vi.mock('./runtime-browser-ipc', () => ({ registerRuntimeBrowserIpc: () => undefined }))
vi.mock('./launcher-update-ipc', () => ({ registerLauncherUpdateIpc: () => undefined }))
vi.mock('./remote-ipc', () => ({ registerRemoteConnectionIpc: () => undefined }))
vi.mock('./p2p/management-ipc', () => ({ registerPeerManagementIpc: () => undefined }))
vi.mock('./launcher-tray', () => ({ getCloseBehavior: vi.fn(), setCloseBehavior: vi.fn() }))

const failures = [
  ['runtime.owner_unavailable', 'managed.runtime_owner_unavailable'],
  ['runtime.owner_identity_mismatch', 'managed.runtime_owner_identity_mismatch'],
  ['runtime.owner_record_invalid', 'managed.runtime_owner_record_invalid'],
  ['runtime.owner_protocol_unsupported', 'managed.runtime_owner_protocol_unsupported'],
  ['runtime.owner_configuration_invalid', 'managed.runtime_owner_configuration_invalid'],
  ['runtime.owner_shutdown_failed', 'managed.runtime_owner_shutdown_failed']
] as const

const request: CoreHarnessLaunchRequest = {
  launchId: 'test-launch',
  subjectId: 'test-installation',
  directory: '/explicit/worktree',
  profile: 'node',
  nodeExecutable: '/explicit/node',
  pnpmExecutable: '',
  pnpmPrefixArguments: [],
  pnpmResolutionError: '',
  pnpmCommandSearchPath: '',
  diagnosticsPatchPath: '',
  port: { mode: 'auto' },
  logPath: ''
}

const routes = [
  { channel: DESKTOP_IPC_CHANNELS.launcherHarnessStart, method: 'runtime.start', args: [] },
  { channel: DESKTOP_IPC_CHANNELS.launcherHarnessStop, method: 'runtime.stop', args: [] },
  { channel: DESKTOP_IPC_CHANNELS.launcherHarnessGetState, method: 'runtime.status', args: [] },
  {
    channel: DESKTOP_IPC_CHANNELS.managedInstallationsStartHarness,
    method: 'runtime.start',
    args: [{ workspaceId: 'test-workspace', installationId: request.subjectId }]
  },
  {
    channel: DESKTOP_IPC_CHANNELS.managedInstallationsStopHarness,
    method: 'runtime.stop',
    args: [{ workspaceId: 'test-workspace', installationId: request.subjectId }]
  },
  {
    channel: DESKTOP_IPC_CHANNELS.managedInstallationsGetState,
    method: 'runtime.status',
    args: []
  }
] as const

function registerRefusingRuntime(code: string) {
  const refusal = new PeerHelperError(code)
  refusal.message = 'private token=sentinel credential and filesystem detail'
  const call = vi.fn(async () => {
    throw refusal
  })
  const runtime = new CoreHarnessRuntime({ call })
  // Test-only service ports join the real CoreHarnessRuntime to the actual
  // registered IPC handlers; no renderer response or error conversion is copied.
  const start = () => runtime.start(request)
  const stop = () => runtime.stop(request.subjectId)
  const getState = () => runtime.status(request.subjectId)
  registerIpc({
    launcherHarnessService: { start, stop, getState, onConsoleAppend: () => undefined },
    managedInstallationService: { startHarness: start, stopHarness: stop, getState }
  } as unknown as LauncherIpcOptions)
  return call
}

describe('runtime owner errors through admitted IPC operations', () => {
  beforeEach(() => {
    ipc.handlers.clear()
    ipc.trusted = true
  })

  for (const [runtimeCode, rendererCode] of failures) {
    it.each(routes)(`${runtimeCode} remains typed through $channel`, async (route) => {
      const call = registerRefusingRuntime(runtimeCode)
      const answer = await ipc.handlers.get(route.channel)?.({}, ...route.args)
      expect(answer).toMatchObject({ ok: false, code: rendererCode, message: expect.any(String) })
      expect(answer).not.toHaveProperty('data')
      expect(JSON.stringify(answer)).not.toMatch(/sentinel|credential|filesystem|token=/)
      expect(call).toHaveBeenCalledExactlyOnceWith(
        route.method,
        route.method === 'runtime.start' ? request : { subjectId: request.subjectId },
        expect.any(AbortSignal)
      )
    })
  }

  it.each(routes)('rejects untrusted $channel before calling the runtime', async (route) => {
    const call = registerRefusingRuntime('runtime.owner_unavailable')
    ipc.trusted = false
    await expect(ipc.handlers.get(route.channel)?.({}, ...route.args)).resolves.toMatchObject({
      ok: false,
      code: 'bootstrap.invalid_sender'
    })
    expect(call).not.toHaveBeenCalled()
  })

  it.each(routes)('rejects extra arguments to $channel without another attempt', async (route) => {
    const call = registerRefusingRuntime('runtime.owner_unavailable')
    await expect(
      ipc.handlers.get(route.channel)?.({}, ...route.args, { extra: true })
    ).resolves.toMatchObject({ ok: false, code: 'managed.selection_invalid' })
    expect(call).not.toHaveBeenCalled()
  })

  it('does not relabel unrelated core errors as runtime-owner failures', async () => {
    const call = registerRefusingRuntime('p2p.invalid_payload')
    await expect(
      ipc.handlers.get(DESKTOP_IPC_CHANNELS.launcherHarnessStart)?.({})
    ).resolves.toEqual({
      ok: false,
      code: 'managed.harness_launch_failed',
      message: 'The Launcher Harness checkout is unavailable.'
    })
    await expect(
      ipc.handlers.get(DESKTOP_IPC_CHANNELS.managedInstallationsStartHarness)?.(
        {},
        {
          workspaceId: 'test-workspace',
          installationId: request.subjectId
        }
      )
    ).rejects.toBeInstanceOf(PeerHelperError)
    expect(call).toHaveBeenCalledTimes(2)
  })
})
