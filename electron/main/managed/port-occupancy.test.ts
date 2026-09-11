import { describe, expect, it, vi } from 'vitest'
import {
  findPortOccupant,
  foreignPortFailure,
  isResidualDshWebCommand,
  parseLsofListenPid,
  parseNetstatListenPid,
  preparePortForLaunch,
  terminatePortOccupant
} from './port-occupancy'

describe('parseLsofListenPid', () => {
  it('reads the pid from the LISTEN line', () => {
    expect(
      parseLsofListenPid(
        [
          'COMMAND   PID        USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
          '',
          'node    87263 a1021500932   17u  IPv4 0xa48a5f6e4d1bd4b6      0t0  TCP 127.0.0.1:3088 (LISTEN)'
        ].join('\n')
      )
    ).toBe(87263)
  })

  it('returns undefined for an empty or header-only listing', () => {
    expect(parseLsofListenPid('COMMAND   PID USER\n')).toBeUndefined()
    expect(parseLsofListenPid('')).toBeUndefined()
  })
})

describe('parseNetstatListenPid', () => {
  it('reads the LISTENING pid for the exact port', () => {
    expect(
      parseNetstatListenPid(
        [
          '  TCP    127.0.0.1:3088  0.0.0.0:0    LISTENING       3194',
          '',
          '  TCP    127.0.0.1:3080  0.0.0.0:0    LISTENING       2721'
        ].join('\n'),
        3088
      )
    ).toBe(3194)
  })

  it('ignores lines whose port does not match', () => {
    expect(
      parseNetstatListenPid('  TCP    127.0.0.1:3080  0.0.0.0:0    LISTENING       2721\n', 3088)
    ).toBeUndefined()
  })
})

describe('isResidualDshWebCommand', () => {
  it('recognizes the pnpm dsh web launch', () => {
    expect(
      isResidualDshWebCommand(
        'node /opt/homebrew/bin/pnpm dsh web --patch /launcher/verbose.patch.yml --no-open --port 3088'
      )
    ).toBe(true)
  })

  it('recognizes a direct node dsh bin launch', () => {
    expect(isResidualDshWebCommand('node --import tsx/esm apps/cli/src/bin.ts web --no-open')).toBe(
      true
    )
  })

  it('does not mistake unrelated node processes for DSH Web', () => {
    expect(isResidualDshWebCommand('node /srv/api/server.js')).toBe(false)
    expect(isResidualDshWebCommand('node --import tsx/esm apps/cli/src/bin.ts check')).toBe(false)
    expect(isResidualDshWebCommand(undefined)).toBe(false)
  })
})

describe('findPortOccupant', () => {
  it('returns undefined when lsof reports nothing', async () => {
    const run = vi.fn(async () => {
      throw new Error('no match')
    })
    expect(await findPortOccupant(3088, 'darwin', run)).toBeUndefined()
    expect(run).toHaveBeenCalledWith('lsof', ['-nP', '-iTCP:3088', '-sTCP:LISTEN'])
  })

  it('reads the pid and command line on POSIX', async () => {
    const calls: Array<readonly [string, readonly string[]]> = []
    const run = async (exe: string, args: readonly string[]) => {
      calls.push([exe, args])
      if (exe === 'lsof')
        return 'COMMAND   PID   USER\nnode    87263 a1021500932   17u  IPv4 0x123 0t0  TCP 127.0.0.1:3088 (LISTEN)\n'
      if (exe === 'ps') return 'node --import tsx/esm apps/cli/src/bin.ts web --no-open\n'
      throw new Error('unexpected ' + exe)
    }
    expect(await findPortOccupant(3088, 'darwin', run)).toEqual({
      pid: 87263,
      commandLine: 'node --import tsx/esm apps/cli/src/bin.ts web --no-open'
    })
    expect(calls[1]).toEqual(['ps', ['-p', '87263', '-o', 'command=']])
  })

  it('keeps the pid even when the command line is unreadable', async () => {
    const run = async (exe: string) => {
      if (exe === 'lsof')
        return 'node    9001 user  17u  IPv4 0x1 0t0  TCP 127.0.0.1:3088 (LISTEN)\n'
      throw new Error('ps failed')
    }
    expect(await findPortOccupant(3088, 'darwin', run)).toEqual({
      pid: 9001,
      commandLine: undefined
    })
  })
})

describe('terminatePortOccupant', () => {
  it('signals SIGTERM and returns once the process is gone', async () => {
    const killProcess = vi.fn().mockReturnValue(true)
    const isAlive = vi.fn().mockImplementation((target: number) => target !== 42)
    const waitMillis = vi.fn(async () => undefined)
    await terminatePortOccupant(42, { killProcess, isAlive, waitMillis })
    expect(killProcess).toHaveBeenCalledWith(42, 'SIGTERM')
    expect(killProcess).not.toHaveBeenCalledWith(42, 'SIGKILL')
    expect(waitMillis).toHaveBeenCalled()
  })

  it('escalates to SIGKILL when SIGTERM does not stop the process', async () => {
    const killProcess = vi.fn().mockReturnValue(true)
    const isAlive = vi.fn().mockReturnValue(true)
    const waitMillis = vi.fn(async () => undefined)
    await terminatePortOccupant(42, { killProcess, isAlive, waitMillis })
    expect(killProcess).toHaveBeenCalledWith(42, 'SIGTERM')
    expect(killProcess).toHaveBeenCalledWith(42, 'SIGKILL')
  })

  it('tolerates an already-gone process', async () => {
    const killProcess = vi.fn().mockImplementation(() => {
      throw new Error('ESRCH')
    })
    await terminatePortOccupant(42, {
      killProcess,
      isAlive: () => false,
      waitMillis: async () => undefined
    })
    expect(killProcess).toHaveBeenCalledTimes(1)
  })
})

describe('preparePortForLaunch', () => {
  it('leaves a free port alone', async () => {
    const decision = await preparePortForLaunch(3088, {
      findOccupant: async () => undefined,
      isResidual: () => false,
      terminate: vi.fn(async () => undefined)
    })
    expect(decision).toEqual({ kind: 'free' })
  })

  it('adopts and stops a leftover DSH Web process', async () => {
    const terminate = vi.fn(async () => undefined)
    const decision = await preparePortForLaunch(3088, {
      findOccupant: async () => ({
        pid: 87263,
        commandLine: 'node --import tsx/esm apps/cli/src/bin.ts web --no-open'
      }),
      isResidual: (line: string | undefined) => line?.includes('bin.ts web') === true,
      terminate
    })
    expect(decision).toEqual({ kind: 'cleared', pid: 87263 })
    expect(terminate).toHaveBeenCalledWith(87263)
  })

  it('refuses an unrecognized holder without touching it', async () => {
    const terminate = vi.fn(async () => undefined)
    const decision = await preparePortForLaunch(3088, {
      findOccupant: async () => ({ pid: 9001, commandLine: 'node /srv/api/server.js' }),
      isResidual: () => false,
      terminate
    })
    expect(decision.kind).toBe('foreign')
    expect(terminate).not.toHaveBeenCalled()
  })
})

describe('foreignPortFailure', () => {
  it('carries the port-in-use code and identifies the holder', () => {
    const error = foreignPortFailure(3088, { pid: 9001, commandLine: 'node /srv/api/server.js' })
    expect(error.code).toBe('runtime.port_in_use')
    expect(error.message).toContain('3088')
    expect(error.message).toContain('9001')
  })

  it('still names the holder when the command line is unknown', () => {
    const error = foreignPortFailure(3088, { pid: 9001, commandLine: undefined })
    expect(error.message).toContain('pid 9001')
  })
})
