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
})
