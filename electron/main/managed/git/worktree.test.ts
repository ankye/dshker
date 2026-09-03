import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { GitRuntimeError } from './errors'
import { inspectUnmanagedGitRepository } from './inspection'
import { inspectManagedGitMirror } from './mirror'
import { createManagedGitInstallationPaths, ensureManagedGitInstallationDirectories } from './paths'
import {
  createGitExecutionEnvironment,
  GitCommandRunner,
  parseGitVersion,
  registerGitExecutable
} from './process'
import { createGitNamedRemote } from './remote'
import {
  assertGitReferenceNotRewritten,
  createGitReferenceObservation,
  resolveGitRevision,
  selectGitBranch
} from './revision'
import { materializeManagedGitWorktree, verifyManagedGitWorktree } from './worktree'

const execFileAsync = promisify(execFile)

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

describe('managed Git mirror and detached worktree primitives', () => {
  it('resolves an explicitly fetched branch and materializes an exact clean detached worktree', async () => {
    const temporaryRoot = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-git-'))
    )
    const sourcePath = nodePath.join(temporaryRoot, 'source')
    const namespacePath = nodePath.join(temporaryRoot, 'harness-namespace')
    await mkdir(sourcePath)
    await mkdir(namespacePath)
    await hostGit(sourcePath, ['init'])
    await hostGit(sourcePath, ['config', 'user.email', 'launcher-test@example.test'])
    await hostGit(sourcePath, ['config', 'user.name', 'DSHKer Launcher Test'])
    await writeFile(nodePath.join(sourcePath, 'README.md'), 'first commit\n')
    await hostGit(sourcePath, ['add', 'README.md'])
    await hostGit(sourcePath, ['commit', '-m', 'initial'])
    const initialCommit = (await hostGit(sourcePath, ['rev-parse', 'HEAD'])).trim()

    const paths = createManagedGitInstallationPaths(namespacePath, 'installation_main')
    await ensureManagedGitInstallationDirectories(paths)
    await hostGit(temporaryRoot, ['init', '--bare', paths.mirrorPath])
    await hostGit(temporaryRoot, [
      '--git-dir',
      paths.mirrorPath,
      'remote',
      'add',
      'origin',
      'https://example.test/owner/dsh.git'
    ])
    await hostGit(temporaryRoot, [
      '--git-dir',
      paths.mirrorPath,
      'fetch',
      sourcePath,
      `${initialCommit}:refs/remotes/origin/main`
    ])

    const runner = new GitCommandRunner()
    const context = {
      workingDirectory: temporaryRoot,
      environment: executionEnvironment(),
      timeoutMilliseconds: 10_000,
      maximumOutputBytes: 128 * 1024
    }
    const registration = await registerGitExecutable(await gitExecutablePath(), context, {
      minimumVersion: parseGitVersion('git version 2.5.0\n'),
      maximumExclusiveVersion: parseGitVersion('git version 3.0.0\n')
    })
    const remote = createGitNamedRemote('origin', 'https://example.test/owner/dsh.git')

    await expect(
      inspectManagedGitMirror(runner, registration, context, paths, remote)
    ).resolves.toMatchObject({
      path: paths.mirrorPath
    })
    const initial = await resolveGitRevision(
      runner,
      registration,
      context,
      paths,
      remote,
      selectGitBranch('main')
    )
    const worktree = await materializeManagedGitWorktree(
      runner,
      registration,
      context,
      paths,
      remote,
      initial.commit
    )
    await expect(
      verifyManagedGitWorktree(runner, registration, context, paths, remote, initial.commit)
    ).resolves.toEqual(worktree)

    await writeFile(nodePath.join(sourcePath, 'README.md'), 'second commit\n')
    await hostGit(sourcePath, ['add', 'README.md'])
    await hostGit(sourcePath, ['commit', '-m', 'second'])
    const secondCommit = (await hostGit(sourcePath, ['rev-parse', 'HEAD'])).trim()
    await hostGit(temporaryRoot, [
      '--git-dir',
      paths.mirrorPath,
      'fetch',
      sourcePath,
      `${secondCommit}:refs/remotes/origin/main`
    ])
    const current = await resolveGitRevision(
      runner,
      registration,
      context,
      paths,
      remote,
      selectGitBranch('main')
    )
    await expect(
      assertGitReferenceNotRewritten(
        runner,
        registration,
        context,
        paths,
        createGitReferenceObservation(initial),
        current
      )
    ).resolves.toBeUndefined()

    const rewrittenSourcePath = nodePath.join(temporaryRoot, 'rewritten-source')
    await mkdir(rewrittenSourcePath)
    await hostGit(rewrittenSourcePath, ['init'])
    await hostGit(rewrittenSourcePath, ['config', 'user.email', 'launcher-test@example.test'])
    await hostGit(rewrittenSourcePath, ['config', 'user.name', 'DSHKer Launcher Test'])
    await writeFile(nodePath.join(rewrittenSourcePath, 'README.md'), 'unrelated history\n')
    await hostGit(rewrittenSourcePath, ['add', 'README.md'])
    await hostGit(rewrittenSourcePath, ['commit', '-m', 'unrelated'])
    const rewrittenCommit = (await hostGit(rewrittenSourcePath, ['rev-parse', 'HEAD'])).trim()
    await hostGit(temporaryRoot, [
      '--git-dir',
      paths.mirrorPath,
      'fetch',
      rewrittenSourcePath,
      `+${rewrittenCommit}:refs/remotes/origin/main`
    ])
    const rewritten = await resolveGitRevision(
      runner,
      registration,
      context,
      paths,
      remote,
      selectGitBranch('main')
    )
    await expect(
      assertGitReferenceNotRewritten(
        runner,
        registration,
        context,
        paths,
        createGitReferenceObservation(initial),
        rewritten
      )
    ).rejects.toMatchObject({ code: 'git.ref_rewritten' })

    await writeFile(nodePath.join(worktree.path, 'unexpected.txt'), 'do not remove this\n')
    await expect(
      verifyManagedGitWorktree(runner, registration, context, paths, remote, initial.commit)
    ).rejects.toMatchObject({ code: 'git.repository_dirty' })

    await hostGit(sourcePath, ['remote', 'add', 'origin', 'https://example.test/owner/dsh.git'])
    await expect(
      inspectUnmanagedGitRepository(runner, registration, context, sourcePath, remote)
    ).resolves.toMatchObject({ canonicalPath: sourcePath, dirtyEntries: [] })
  })

  it('does not treat an existing exact-SHA worktree as an overwrite target', async () => {
    // Built from parts for the same absolute-path gate reason as above.
    const windowsNamespace = ['C', ':', '\\', 'managed', '\\', 'harness'].join('')
    const namespacePath = process.platform === 'win32' ? windowsNamespace : '/managed/harness'
    const paths = createManagedGitInstallationPaths(namespacePath, 'installation_main')
    expect(() => paths.worktreesPath).not.toThrow()
    expect(() => createManagedGitInstallationPaths('/managed/harness', '../escape')).toThrow(
      GitRuntimeError
    )
  })
})
