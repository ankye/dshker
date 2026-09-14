import { describe, expect, it } from 'vitest'
import { PeerHelperError } from '../p2p/wire'
import { CoreHarnessRuntime, type CoreHarnessLaunchView } from './harness-runtime'

function launchView(): CoreHarnessLaunchView {
  return {
    launchId: 'launch-1',
    subjectId: 'launcher-harness',
    state: 'running',
    url: 'http://127.0.0.1:3088/?token=abc',
    pid: 4242,
    directory: '/launcher/versions/abc',
    port: { mode: 'fixed', port: 3088 },
    diagnostics: {
      stdoutBytes: 12,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false
    }
  }
}

function fakeRpc(answer: (method: string, payload: unknown) => unknown) {
  const calls: { method: string; payload: unknown }[] = []
  return {
    calls,
    call: (method: string, payload: unknown): Promise<unknown> => {
      calls.push({ method, payload })
      return Promise.resolve(answer(method, payload))
    }
  }
}

describe('core harness runtime client', () => {
  it('sends the launch request the core builds the command from', async () => {
    const rpc = fakeRpc(() => ({ launch: launchView() }))
    const request = {
      launchId: 'launch-1',
      subjectId: 'launcher-harness',
      directory: '/launcher/versions/abc',
      pnpmExecutable: '/opt/pnpm',
      pnpmPrefixArguments: ['shim.js'],
      pnpmResolutionError: '',
      pnpmCommandSearchPath: '/opt/bin',
      diagnosticsPatchPath: '/launcher/verbose.patch.yml',
      port: { mode: 'auto' as const },
      logPath: '/launcher/logs/dsh-web.log'
    }
    await expect(new CoreHarnessRuntime(rpc).start(request)).resolves.toEqual(launchView())
    expect(rpc.calls).toEqual([{ method: 'runtime.start', payload: request }])
  })

  it('reports a subject that never ran as no launch at all', async () => {
    const rpc = fakeRpc(() => ({ present: false }))
    await expect(new CoreHarnessRuntime(rpc).status('launcher-harness')).resolves.toBeUndefined()
    expect(rpc.calls).toEqual([
      { method: 'runtime.status', payload: { subjectId: 'launcher-harness' } }
    ])
  })

  it('carries the console cursor and the entries the core retained', async () => {
    const rpc = fakeRpc(() => ({
      entries: [{ seq: 7, stream: 'command', text: '$ dsh web\n', occurredAt: 1 }],
      cursor: 7
    }))
    await expect(new CoreHarnessRuntime(rpc).console(3)).resolves.toEqual({
      entries: [{ seq: 7, stream: 'command', text: '$ dsh web\n', occurredAt: 1 }],
      cursor: 7
    })
    expect(rpc.calls).toEqual([{ method: 'runtime.console', payload: { cursor: 3 } }])
  })

  it('reads and writes the port document the core owns', async () => {
    const rpc = fakeRpc((method) =>
      method === 'runtime.port_get'
        ? { port: { mode: 'auto' } }
        : { port: { mode: 'fixed', port: 3088 } }
    )
    const client = new CoreHarnessRuntime(rpc)
    await expect(client.portGet('/launcher/launch-preferences.json')).resolves.toEqual({
      mode: 'auto'
    })
    await expect(
      client.portSet('/launcher/launch-preferences.json', { mode: 'fixed', port: 3088 })
    ).resolves.toEqual({ mode: 'fixed', port: 3088 })
    expect(rpc.calls[1]).toEqual({
      method: 'runtime.port_set',
      payload: {
        filePath: '/launcher/launch-preferences.json',
        port: { mode: 'fixed', port: 3088 }
      }
    })
  })

  it('refuses an answer that is not a launch record', async () => {
    await expect(
      new CoreHarnessRuntime(fakeRpc(() => ({}))).start({} as never)
    ).rejects.toMatchObject({ code: 'p2p.invalid_payload' })
    await expect(
      new CoreHarnessRuntime(fakeRpc(() => null)).status('launcher-harness')
    ).resolves.toBeUndefined()
  })

  it('carries the core refusal through unchanged', async () => {
    const rpc = fakeRpc(() => {
      throw new PeerHelperError('runtime.operation_in_progress')
    })
    await expect(new CoreHarnessRuntime(rpc).start({} as never)).rejects.toMatchObject({
      code: 'runtime.operation_in_progress'
    })
  })
})
