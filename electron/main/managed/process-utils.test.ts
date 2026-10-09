import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertDirectDirectory,
  assertDirectRegularFile,
  RunTextTimeoutError,
  runText
} from './process-utils'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('direct filesystem path admission', () => {
  it('accepts canonical aliases but refuses symbolic-link path components', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'launcher-direct-path-'))
    const root = await realpath(temporaryRoot)
    temporaryRoots.push(root)
    const ownedDirectory = path.join(root, 'owned')
    const ownedFile = path.join(ownedDirectory, 'entry.txt')
    const linkedDirectory = path.join(root, 'linked')
    await mkdir(ownedDirectory)
    await writeFile(ownedFile, 'ok')

    await expect(assertDirectDirectory(ownedDirectory)).resolves.toBeUndefined()
    await expect(assertDirectRegularFile(ownedFile)).resolves.toBeUndefined()

    if (process.platform === 'win32') {
      const caseAlias = ownedDirectory.toUpperCase()
      await expect(assertDirectDirectory(caseAlias)).resolves.toBeUndefined()
      await expect(
        assertDirectRegularFile(path.join(caseAlias, 'ENTRY.TXT'))
      ).resolves.toBeUndefined()
    }

    await symlink(
      ownedDirectory,
      linkedDirectory,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(assertDirectDirectory(linkedDirectory)).rejects.toThrow()
    await expect(assertDirectRegularFile(path.join(linkedDirectory, 'entry.txt'))).rejects.toThrow()

    const evidenceDirectory = path.resolve(process.cwd(), '.run/windows-path-admission')
    await mkdir(evidenceDirectory, { recursive: true })
    await writeFile(
      path.join(evidenceDirectory, 'verification.json'),
      `${JSON.stringify(
        {
          format: 'dsh-launcher-path-admission-verification',
          platform: process.platform,
          directDirectoryAccepted: true,
          directRegularFileAccepted: true,
          windowsCaseAliasAccepted: process.platform === 'win32',
          symbolicLinkComponentsRejected: true
        },
        null,
        2
      )}\n`,
      'utf8'
    )
  })
})

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
