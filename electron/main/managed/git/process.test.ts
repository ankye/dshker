import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { GitRuntimeError } from './errors'
import {
  assertRegisteredGitExecutable,
  createGitExecutionEnvironment,
  GitCommandRunner,
  parseGitVersion,
  pinGitExecutable,
  redactGitOutput
} from './process'
import type { GitExecutableRegistration, GitExecutionContext } from './types'

function context(): GitExecutionContext {
  return {
    workingDirectory: process.cwd(),
    environment: createGitExecutionEnvironment({
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

function windowsEnvironment(name: string): string | undefined {
  return Object.entries(process.env).find(([key]) => key.toUpperCase() === name)?.[1]
}

async function nodeRegistration(): Promise<GitExecutableRegistration> {
  return {
    ...(await pinGitExecutable(process.execPath)),
    version: parseGitVersion('git version 2.43.0\n')
  }
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

describe('managed Git process runner', () => {
  it('uses an exact executable with a shell-free explicit environment and redacts command output', async () => {
    const child = fakeChild()
    const spawnProcess = vi.fn(() => child as never)
    const runner = new GitCommandRunner(spawnProcess)
    const registration = await nodeRegistration()
    const run = runner.run(registration, context(), {
      operation: 'git.test_probe',
      arguments: ['remote', 'https://token:secret@example.test/owner/repo.git']
    })

    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce())
    child.stdout.write('https://token:secret@example.test/owner/repo.git\n')
    child.stderr.end('authorization=secret\n')
    child.stdout.end()
    child.emit('close', 0, null)

    await expect(run).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'https://[REDACTED]@example.test/owner/repo.git\n',
      stderr: 'authorization=[REDACTED]\n'
    })
    expect(spawnProcess).toHaveBeenCalledWith(
      registration.canonicalPath,
      [
        '--no-pager',
        '-c',
        'credential.helper=',
        '-c',
        `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
        ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []),
        'remote',
        'https://token:secret@example.test/owner/repo.git'
      ],
      expect.objectContaining({
        shell: false,
        cwd: process.cwd(),
        env: context().environment,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    )
  })

  it('rejects ambient PATH input and bounded-output overflow before a result reaches the caller', async () => {
    await expect(
      new GitCommandRunner().run(
        await nodeRegistration(),
        {
          ...context(),
          environment: { ...context().environment, PATH: '/unsafe' }
        },
        { operation: 'git.test_probe', arguments: ['--version'] }
      )
    ).rejects.toMatchObject({ code: 'git.command_invalid' })

    const child = fakeChild()
    const spawnProcess = vi.fn(() => child as never)
    const runner = new GitCommandRunner(spawnProcess)
    const overflowing = runner.run(
      await nodeRegistration(),
      { ...context(), maximumOutputBytes: 1 },
      {
        operation: 'git.test_output',
        arguments: ['--version']
      }
    )
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce())
    child.stdout.write('too much output')
    child.stdout.end()
    child.stderr.end()
    child.emit('close', null, 'SIGTERM')

    await expect(overflowing).rejects.toMatchObject({ code: 'git.command_output_limit' })
    expect(redactGitOutput('https://a:b@example.test/x')).toBe('https://[REDACTED]@example.test/x')
  })

  it('parses only a complete Git version line', () => {
    expect(parseGitVersion('git version 2.44.1\n')).toEqual({
      major: 2,
      minor: 44,
      patch: 1,
      text: '2.44.1'
    })
    expect(() => parseGitVersion('2.44.1')).toThrow(GitRuntimeError)
  })

  it('rejects a registered executable whose pinned file identity changed', async () => {
    const registration = await nodeRegistration()

    await expect(
      assertRegisteredGitExecutable({
        ...registration,
        fingerprint: { ...registration.fingerprint, size: registration.fingerprint.size + 1 }
      })
    ).rejects.toMatchObject({ code: 'git.executable_changed' })
  })
})
