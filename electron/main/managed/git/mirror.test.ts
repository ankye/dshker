import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import {
  createManagedGitMirror,
  createManagedGitMirrorFromBundle,
  fetchManagedGitMirror
} from './mirror'
import { createManagedGitInstallationPaths } from './paths'
import {
  createGitExecutionEnvironment,
  GitCommandRunner,
  parseGitVersion,
  registerGitExecutable
} from './process'
import { createGitNamedRemote } from './remote'
import { resolveGitRevision, selectGitBranch } from './revision'
import { materializeManagedGitWorktree, verifyManagedGitWorktree } from './worktree'
import type {
  GitCommand,
  GitCommandResult,
  GitExecutableRegistration,
  GitExecutionContext
} from './types'

const execFileAsync = promisify(execFile)

/**
 * Probes whether this environment may create file symlinks: Windows denies it
 * without the SeCreateSymbolicLink privilege (or Developer Mode). The bundle
 * alias rejection scenario needs one, so the test skips where none can exist.
 */
async function probeFileSymlinkSupport(): Promise<boolean> {
  const directory = await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-symlink-probe-'))
  try {
    const target = nodePath.join(directory, 'target.bundle')
    await writeFile(target, 'x')
    await symlink(target, nodePath.join(directory, 'alias.bundle'))
    return true
  } catch {
    return false
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const fileSymlinksSupported = await probeFileSymlinkSupport()

async function hostGit(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...arguments_], { cwd, encoding: 'utf8' })
  return result.stdout
}

async function gitExecutablePath(): Promise<string> {
  const command = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = await execFileAsync(command, ['git'], { encoding: 'utf8' })
  const executable = result.stdout.split(/\r?\n/).find(Boolean)
  if (!executable) throw new Error('Git executable was not found by the test fixture.')
  return realpath(executable)
}

function executionEnvironment(): Readonly<Record<string, string>> {
  return createGitExecutionEnvironment({
    platform: process.platform,
    ...(process.platform === 'win32'
      ? {
          systemRoot: windowsEnvironment('SYSTEMROOT'),
          windir: windowsEnvironment('WINDIR'),
          comspec: windowsEnvironment('COMSPEC'),
          pathExt: windowsEnvironment('PATHEXT')
        }
      : {})
  })
}

function windowsEnvironment(name: string): string | undefined {
  return Object.entries(process.env).find(([key]) => key.toUpperCase() === name)?.[1]
}

function successfulResult(command: GitCommand, stdout = ''): GitCommandResult {
  return {
    operation: command.operation,
    executablePath: '/registered/git',
    workingDirectory: '/explicit/cwd',
    environmentNames: [],
    arguments: command.arguments,
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    elapsedMilliseconds: 0
  }
}

describe('managed bare-mirror publication', () => {
  it('stages a mirror, verifies its one declared remote, publishes it, and fetches only that remote', async () => {
    const namespacePath = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-mirror-'))
    )
    const paths = createManagedGitInstallationPaths(namespacePath, 'installation_main')
    const remote = createGitNamedRemote('origin', 'https://example.test/owner/dsh.git')
    const run = vi.fn(
      async (
        _registration: GitExecutableRegistration,
        _context: GitExecutionContext,
        command: GitCommand
      ) => {
        switch (command.operation) {
          case 'git.create_bare_mirror':
            await mkdir(command.arguments[2])
            return successfulResult(command)
          case 'git.verify_bare_mirror':
            return successfulResult(command, 'true\n')
          case 'git.read_mirror_remote_names':
            return successfulResult(command, 'origin\n')
          case 'git.read_mirror_remote_url':
            return successfulResult(command, 'https://example.test/owner/dsh.git\n')
          case 'git.read_mirror_remote_push_url':
          case 'git.inspect_mirror_rewrite_configuration':
            return { ...successfulResult(command), exitCode: 1 }
          default:
            return successfulResult(command)
        }
      }
    )
    const runner = { run } as unknown as GitCommandRunner
    const registration = {} as GitExecutableRegistration
    const context = {} as GitExecutionContext

    const created = await createManagedGitMirror(runner, registration, context, paths, remote)
    expect(created).toEqual({ path: paths.mirrorPath, remote })
    await expect(
      createManagedGitMirror(runner, registration, context, paths, remote)
    ).rejects.toMatchObject({ code: 'git.mirror_exists' })
    await expect(
      fetchManagedGitMirror(runner, registration, context, paths, remote)
    ).resolves.toEqual(created)
    expect(run.mock.calls.map(([, , command]) => command.operation)).toContain(
      'git.create_bare_mirror'
    )
    expect(run.mock.calls.map(([, , command]) => command.operation)).toContain(
      'git.fetch_managed_mirror'
    )
    const fetchCommand = run.mock.calls
      .map(([, , command]) => command)
      .find((command) => command.operation === 'git.fetch_managed_mirror')
    expect(fetchCommand?.arguments).toContain('origin')
    expect(fetchCommand?.arguments).not.toContain('file:///untrusted/repository.git')
  })

  it('imports a direct regular bundle into normal remote-tracking refs without retaining the bundle as a remote', async () => {
    const namespacePath = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-bundle-mirror-'))
    )
    const paths = createManagedGitInstallationPaths(namespacePath, 'installation_bundle')
    const remote = createGitNamedRemote('origin', 'https://example.test/owner/dsh.git')
    const bundlePath = nodePath.join(namespacePath, 'dsh.git.bundle')
    await writeFile(bundlePath, 'verified bundle')
    const run = vi.fn(
      async (
        _registration: GitExecutableRegistration,
        _context: GitExecutionContext,
        command: GitCommand
      ) => {
        switch (command.operation) {
          case 'git.create_bare_mirror':
            await mkdir(command.arguments[2])
            return successfulResult(command)
          case 'git.verify_bare_mirror':
            return successfulResult(command, 'true\n')
          case 'git.read_mirror_remote_names':
            return successfulResult(command, 'origin\n')
          case 'git.read_mirror_remote_url':
            return successfulResult(command, 'https://example.test/owner/dsh.git\n')
          case 'git.read_mirror_remote_push_url':
          case 'git.inspect_mirror_rewrite_configuration':
            return { ...successfulResult(command), exitCode: 1 }
          default:
            return successfulResult(command)
        }
      }
    )
    const runner = { run } as unknown as GitCommandRunner
    const registration = {} as GitExecutableRegistration
    const context = {} as GitExecutionContext

    await expect(
      createManagedGitMirrorFromBundle(runner, registration, context, paths, remote, bundlePath)
    ).resolves.toEqual({ path: paths.mirrorPath, remote })

    const commands = run.mock.calls.map(([, , command]) => command)
    const importCommand = commands.find(
      (command) => command.operation === 'git.import_bundle_objects'
    )
    expect(importCommand?.arguments).toEqual([
      '--git-dir',
      expect.stringContaining(`${nodePath.sep}staging${nodePath.sep}mirror-`),
      'fetch',
      '--atomic',
      '--no-write-fetch-head',
      '--no-tags',
      '--',
      bundlePath,
      '+refs/heads/*:refs/remotes/origin/*',
      '+refs/tags/*:refs/tags/*'
    ])
    const importedAt = commands.findIndex(
      (command) => command.operation === 'git.import_bundle_objects'
    )
    const remoteAddedAt = commands.findIndex(
      (command) => command.operation === 'git.add_mirror_remote'
    )
    expect(importedAt).toBeGreaterThanOrEqual(0)
    expect(remoteAddedAt).toBeGreaterThan(importedAt)
    expect(commands.map((command) => command.operation)).not.toContain('git.fetch_managed_mirror')
  })

  it.skipIf(!fileSymlinksSupported)(
    'rejects a bundle alias before invoking the registered Git executable',
    async () => {
      const namespacePath = await realpath(
        await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-bundle-alias-'))
      )
      const paths = createManagedGitInstallationPaths(namespacePath, 'installation_alias')
      const remote = createGitNamedRemote('origin', 'https://example.test/owner/dsh.git')
      const bundlePath = nodePath.join(namespacePath, 'dsh.git.bundle')
      const aliasPath = nodePath.join(namespacePath, 'dsh-alias.bundle')
      await writeFile(bundlePath, 'verified bundle')
      await symlink(bundlePath, aliasPath)
      const run = vi.fn()
      const runner = { run } as unknown as GitCommandRunner

      await expect(
        createManagedGitMirrorFromBundle(
          runner,
          {} as GitExecutableRegistration,
          {} as GitExecutionContext,
          paths,
          remote,
          aliasPath
        )
      ).rejects.toMatchObject({ code: 'git.repository_invalid' })
      expect(run).not.toHaveBeenCalled()
    }
  )

  it('resolves and materializes a bundled branch through the normal managed mirror APIs', async () => {
    const temporaryRoot = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-bundle-runtime-'))
    )
    const sourcePath = nodePath.join(temporaryRoot, 'source')
    const namespacePath = nodePath.join(temporaryRoot, 'harness-namespace')
    const bundlePath = nodePath.join(temporaryRoot, 'dsh.git.bundle')
    await mkdir(sourcePath)
    await mkdir(namespacePath)
    await hostGit(sourcePath, ['init'])
    await hostGit(sourcePath, ['config', 'user.email', 'launcher-test@example.test'])
    await hostGit(sourcePath, ['config', 'user.name', 'DSHKer Launcher Test'])
    await writeFile(nodePath.join(sourcePath, 'README.md'), 'bundled commit\n')
    await hostGit(sourcePath, ['add', 'README.md'])
    await hostGit(sourcePath, ['commit', '-m', 'initial'])
    await hostGit(sourcePath, ['branch', '--move', 'main'])
    const expectedCommit = (await hostGit(sourcePath, ['rev-parse', 'HEAD'])).trim()
    await hostGit(sourcePath, ['bundle', 'create', bundlePath, '--branches', '--tags'])

    const paths = createManagedGitInstallationPaths(namespacePath, 'installation_runtime')
    const remote = createGitNamedRemote('origin', 'https://example.test/owner/dsh.git')
    const runner = new GitCommandRunner()
    const context = {
      workingDirectory: temporaryRoot,
      environment: executionEnvironment(),
      timeoutMilliseconds: 10_000,
      maximumOutputBytes: 128 * 1024
    }
    const registration = await registerGitExecutable(await gitExecutablePath(), context, {
      minimumVersion: parseGitVersion('git version 2.30.0\n'),
      maximumExclusiveVersion: parseGitVersion('git version 3.0.0\n')
    })

    await createManagedGitMirrorFromBundle(runner, registration, context, paths, remote, bundlePath)
    const resolved = await resolveGitRevision(
      runner,
      registration,
      context,
      paths,
      remote,
      selectGitBranch('main')
    )
    expect(resolved.commit).toBe(expectedCommit)
    const worktree = await materializeManagedGitWorktree(
      runner,
      registration,
      context,
      paths,
      remote,
      resolved.commit
    )
    await expect(
      verifyManagedGitWorktree(runner, registration, context, paths, remote, resolved.commit)
    ).resolves.toEqual(worktree)
  })
})
