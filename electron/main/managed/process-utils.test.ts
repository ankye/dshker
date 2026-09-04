import { describe, expect, it } from 'vitest'
import { RunTextTimeoutError, runText } from './process-utils'

describe('runText', () => {
  it('returns a timeout error and delegates process termination to its caller', async () => {
    let terminatedProcessId: number | undefined

    await expect(
      runText(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: process.platform !== 'win32',
        timeoutMilliseconds: 20,
        onTimeout: (processId) => {
          terminatedProcessId = processId
          if (processId !== undefined) process.kill(processId, 'SIGTERM')
        }
      })
    ).rejects.toBeInstanceOf(RunTextTimeoutError)

    expect(terminatedProcessId).toEqual(expect.any(Number))
  })

  it('streams each stdout and stderr fragment while still resolving with stdout', async () => {
    const fragments: string[] = []

    const output = await runText(
      process.execPath,
      ['-e', 'console.log("out line"); console.error("err line")'],
      {
        onOutput: (stream, text) => {
          fragments.push(`${stream}:${text.trim()}`)
        }
      }
    )

    // Result collection is unchanged: the caller still receives stdout only.
    expect(output).toContain('out line')
    expect(fragments).toContain('stdout:out line')
    expect(fragments).toContain('stderr:err line')
  })
})
