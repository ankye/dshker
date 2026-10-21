import { describe, expect, it, vi } from 'vitest'
import {
  createManagedDshCommandSearchPathResolver,
  loginShellInvocation,
  parseLoginShellPath,
  readInheritedPath
} from './dsh-command-search-path'

function markedPath(command: string, value: string): string {
  const begin = command.match(/__DSHKER_PATH_BEGIN_[0-9a-f-]+__/u)?.[0]
  const end = command.match(/__DSHKER_PATH_END_[0-9a-f-]+__/u)?.[0]
  if (begin === undefined || end === undefined) throw new Error('Path markers were not present.')
  return `shell startup output\n${begin}${value}${end}\n`
}

describe('managed DSH command search path', () => {
  it('puts the bundled runtime first, then inherited paths, then unique login-shell paths', async () => {
    const executeLoginShell = vi.fn(
      async (
        _shell: string,
        arguments_: readonly string[],
        _options: { argv0: string; timeoutMilliseconds: number; maxBufferBytes: number }
      ) =>
        markedPath(arguments_.at(-1) ?? '', '/opt/dev/.local/bin:/bin:/opt/Tools With Spaces/bin')
    )
    const resolver = createManagedDshCommandSearchPathResolver({
      platform: 'darwin',
      environment: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
      bundledRuntimeBin: '/opt/DSHKer/runtime/bin',
      executeLoginShell
    })

    await expect(resolver()).resolves.toBe(
      '/opt/DSHKer/runtime/bin:/usr/bin:/bin:/opt/dev/.local/bin:/opt/Tools With Spaces/bin'
    )
    expect(executeLoginShell).toHaveBeenCalledTimes(1)
    expect(executeLoginShell.mock.calls[0]?.[0]).toBe('/bin/zsh')
    expect(executeLoginShell.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['-l', '-i', '-c']))
    expect(executeLoginShell.mock.calls[0]?.[2]).toMatchObject({
      argv0: '-zsh',
      timeoutMilliseconds: 8_000
    })
  })

  it('supports login-interactive bash, zsh, fish, sh and dash without shell lookup fallbacks', () => {
    expect(loginShellInvocation('/bin/bash', 'command', 'linux')).toMatchObject({
      shell: 'bash',
      argv0: '-bash',
      arguments: ['-l', '-i', '-c', 'command']
    })
    expect(loginShellInvocation('/bin/zsh', 'command', 'darwin').arguments).toEqual([
      '-l',
      '-i',
      '-c',
      'command'
    ])
    expect(loginShellInvocation('/usr/bin/fish', 'command', 'linux').arguments).toEqual([
      '-l',
      '-i',
      '-c',
      'command'
    ])
    expect(loginShellInvocation('/bin/sh', 'command', 'linux')).toMatchObject({
      shell: 'sh',
      argv0: '-sh',
      arguments: ['-i', '-c', 'command']
    })
    expect(loginShellInvocation('/bin/dash', 'command', 'linux')).toMatchObject({
      shell: 'dash',
      argv0: '-dash',
      arguments: ['-i', '-c', 'command']
    })
  })

  it('does not start a shell on Windows and preserves the case-insensitive inherited PATH', async () => {
    const executeLoginShell = vi.fn()
    const resolver = createManagedDshCommandSearchPathResolver({
      platform: 'win32',
      environment: {
        Path: 'c:\\dshker\\runtime\\bin;C:\\Windows\\System32;C:\\Home\\dev\\AppData\\Roaming\\npm'
      },
      bundledRuntimeBin: 'C:\\DSHKer\\runtime\\bin',
      executeLoginShell
    })

    await expect(resolver()).resolves.toBe(
      'C:\\DSHKer\\runtime\\bin;C:\\Windows\\System32;C:\\Home\\dev\\AppData\\Roaming\\npm'
    )
    expect(executeLoginShell).not.toHaveBeenCalled()
    expect(readInheritedPath({ pAtH: 'C:\\tools' }, 'win32')).toBe('C:\\tools')
  })

  it('accepts one terminal Windows PATH delimiter without adding an empty search entry', async () => {
    const resolver = createManagedDshCommandSearchPathResolver({
      platform: 'win32',
      environment: { Path: 'C:\\Windows\\System32;C:\\Users\\Administrator\\scoop\\shims;' },
      bundledRuntimeBin: 'C:\\DSHKer\\runtime\\bin'
    })

    await expect(resolver()).resolves.toBe(
      'C:\\DSHKer\\runtime\\bin;C:\\Windows\\System32;C:\\Users\\Administrator\\scoop\\shims'
    )
  })

  it('continues to reject interior, leading, and repeated terminal Windows PATH delimiters', async () => {
    for (const inheritedPath of [
      ';C:\\Windows\\System32',
      'C:\\first;;C:\\second',
      'C:\\Windows\\System32;;',
      ';'
    ]) {
      const resolver = createManagedDshCommandSearchPathResolver({
        platform: 'win32',
        environment: { Path: inheritedPath },
        bundledRuntimeBin: 'C:\\DSHKer\\runtime\\bin'
      })

      await expect(resolver()).rejects.toMatchObject({
        code: 'runtime.spawn_failed',
        message: 'The inherited PATH contains an empty entry.'
      })
    }
  })

  it('rejects conflicting Windows PATH spellings instead of choosing one', async () => {
    const resolver = createManagedDshCommandSearchPathResolver({
      platform: 'win32',
      environment: { PATH: 'C:\\first', Path: 'C:\\second' }
    })

    await expect(resolver()).rejects.toMatchObject({
      code: 'runtime.spawn_failed',
      message: 'The inherited PATH variables conflict.'
    })
  })

  it('refuses a Windows launch when the inherited PATH is missing', async () => {
    const resolver = createManagedDshCommandSearchPathResolver({
      platform: 'win32',
      environment: {},
      bundledRuntimeBin: 'C:\\DSHKer\\runtime\\bin'
    })

    await expect(resolver()).rejects.toMatchObject({
      code: 'runtime.spawn_failed',
      message: 'The inherited Windows PATH is unavailable.'
    })
  })

  it('rejects an unavailable or unsupported configured POSIX shell without substituting another shell', async () => {
    const executeLoginShell = vi.fn()
    const unavailable = createManagedDshCommandSearchPathResolver({
      platform: 'linux',
      environment: { PATH: '/usr/bin' },
      executeLoginShell
    })
    const unsupported = createManagedDshCommandSearchPathResolver({
      platform: 'linux',
      environment: { SHELL: '/usr/bin/nu', PATH: '/usr/bin' },
      executeLoginShell
    })

    await expect(unavailable()).rejects.toMatchObject({
      code: 'runtime.spawn_failed',
      message: 'The configured login shell is unavailable.'
    })
    await expect(unsupported()).rejects.toMatchObject({
      code: 'runtime.spawn_failed',
      message: 'The configured login shell is unsupported.'
    })
    expect(executeLoginShell).not.toHaveBeenCalled()
  })

  it('accepts only one non-empty marked PATH and preserves spaces in entries', () => {
    expect(
      parseLoginShellPath(
        'profile message\n__DSHKER_PATH_BEGIN_marker__/bin:/opt/Tool Bin__DSHKER_PATH_END_marker__\n',
        'marker',
        ':',
        'linux'
      )
    ).toBe('/bin:/opt/Tool Bin')

    expect(() => parseLoginShellPath('__DSHKER_PATH_BEGIN_marker__/bin', 'marker', ':')).toThrow()
    expect(() =>
      parseLoginShellPath(
        '__DSHKER_PATH_BEGIN_marker__/bin__DSHKER_PATH_END_marker__' +
          '__DSHKER_PATH_BEGIN_marker__/usr/bin__DSHKER_PATH_END_marker__',
        'marker',
        ':'
      )
    ).toThrow()
    expect(() =>
      parseLoginShellPath('__DSHKER_PATH_BEGIN_marker____DSHKER_PATH_END_marker__', 'marker', ':')
    ).toThrow()
  })

  it('bounds login-shell execution, reports timeout as a typed launch error and retries failures', async () => {
    const executeLoginShell = vi
      .fn<(_shell: string, arguments_: readonly string[]) => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
      .mockImplementationOnce(async (_shell, arguments_) =>
        markedPath(arguments_.at(-1) ?? '', '/usr/bin:/opt/cocos/bin')
      )
    const resolver = createManagedDshCommandSearchPathResolver({
      platform: 'linux',
      environment: { SHELL: '/bin/bash', PATH: '/usr/bin' },
      executeLoginShell
    })

    await expect(resolver()).rejects.toMatchObject({
      code: 'runtime.spawn_failed',
      message: 'The configured login shell did not finish within 8 seconds.'
    })
    await expect(resolver()).resolves.toBe('/usr/bin:/opt/cocos/bin')
    expect(executeLoginShell).toHaveBeenCalledTimes(2)
  })

  it('caches only successful values and leaves the launcher environment unchanged', async () => {
    const environment = { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }
    const originalLauncherPath = process.env.PATH
    const executeLoginShell = vi.fn(
      async (
        _shell: string,
        arguments_: readonly string[],
        _options: { argv0: string; timeoutMilliseconds: number; maxBufferBytes: number }
      ) => markedPath(arguments_.at(-1) ?? '', '/opt/dev/.local/bin')
    )
    const resolver = createManagedDshCommandSearchPathResolver({
      platform: 'darwin',
      environment,
      executeLoginShell
    })

    const first = await resolver()
    const second = await resolver()

    expect(second).toBe(first)
    expect(executeLoginShell).toHaveBeenCalledTimes(1)
    expect(environment.PATH).toBe('/usr/bin:/bin')
    expect(process.env.PATH).toBe(originalLauncherPath)
  })
})
