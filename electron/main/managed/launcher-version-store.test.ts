import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  materializeLauncherVersion,
  pruneInactiveVersions,
  readCurrentVersionPointer,
  versionDirectory,
  writeCurrentVersionPointer
} from './launcher-version-store'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(repository: string, arguments_: readonly string[]): string {
  return execFileSync('git', ['-C', repository, ...arguments_], {
    encoding: 'utf8',
    windowsHide: true
  }).trim()
}

function commit(repository: string, message: string): string {
  git(repository, ['add', '--all'])
  git(repository, ['commit', '-m', message])
  return git(repository, ['rev-parse', 'HEAD'])
}

function createRepository(): {
  readonly repository: string
  readonly versions: string
  readonly pointer: string
  readonly previousCommit: string
  readonly targetCommit: string
} {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'launcher-version-store-')))
  roots.push(root)
  const repository = path.join(root, 'harness')
  const versions = path.join(root, 'versions')
  mkdirSync(repository, { recursive: true })
  mkdirSync(versions, { recursive: true })
  execFileSync('git', ['init', '--initial-branch=master', repository], {
    encoding: 'utf8',
    windowsHide: true
  })
  git(repository, ['config', 'user.name', 'Launcher Test'])
  git(repository, ['config', 'user.email', 'launcher-test@example.invalid'])
  writeFileSync(path.join(repository, 'package.json'), '{"name":"harness-test"}\n')
  mkdirSync(path.join(repository, 'apps', 'cli', 'src'), { recursive: true })
  writeFileSync(path.join(repository, 'apps', 'cli', 'src', 'bin.ts'), 'export {}\n')
  const previousCommit = commit(repository, 'initial source')
  writeFileSync(
    path.join(repository, 'apps', 'cli', 'src', 'bin.ts'),
    'export const current = true\n'
  )
  const targetCommit = commit(repository, 'selected source')
  git(repository, ['update-ref', 'refs/remotes/origin/master', targetCommit])
  return {
    repository,
    versions,
    pointer: path.join(root, 'current-version.json'),
    previousCommit,
    targetCommit
  }
}

function steps(build: (directory: string) => Promise<void>) {
  return {
    loggedStep: async <T>(_description: string, step: () => Promise<T>): Promise<T> => step(),
    install: async () => undefined,
    build,
    reconcilePlugins: async () => undefined,
    validate: async () => undefined,
    event: () => undefined
  }
}

describe('managed DSH version worktree recovery', () => {
  it('preserves an incomplete version when it is still the active pointer target', async () => {
    const { repository, versions, pointer, targetCommit } = createRepository()
    await writeCurrentVersionPointer(pointer, targetCommit)
    const target = versionDirectory(versions, targetCommit)
    let installStarted = false

    await expect(
      materializeLauncherVersion('git', repository, versions, pointer, targetCommit, {
        ...steps(async () => undefined),
        install: async () => {
          installStarted = true
        }
      })
    ).rejects.toMatchObject({ code: 'runtime.worktree_invalid' })

    expect(await readCurrentVersionPointer(pointer)).toBe(targetCommit)
    expect(existsSync(target)).toBe(false)
    expect(installStarted).toBe(false)
  })

  it('refuses recovery with a typed error when Git worktree registrations cannot be read', async () => {
    const { repository, versions, pointer, targetCommit } = createRepository()
    const invalidRepository = path.join(path.dirname(repository), 'not-a-git-repository')
    mkdirSync(invalidRepository)

    await expect(
      materializeLauncherVersion(
        'git',
        invalidRepository,
        versions,
        pointer,
        targetCommit,
        steps(async () => undefined)
      )
    ).rejects.toMatchObject({ code: 'runtime.worktree_invalid' })
  })

  it('removes only a stale failed worktree registration before retrying the same commit', async () => {
    const { repository, versions, pointer, previousCommit, targetCommit } = createRepository()
    await writeCurrentVersionPointer(pointer, previousCommit)
    const target = versionDirectory(versions, targetCommit)

    await expect(
      materializeLauncherVersion('git', repository, versions, pointer, targetCommit, {
        ...steps(async () => {
          throw new Error('native build failed')
        })
      })
    ).rejects.toThrow('native build failed')
    expect(await readCurrentVersionPointer(pointer)).toBe(previousCommit)
    expect(existsSync(target)).toBe(true)

    // Reproduce the log: failed preparation directory was removed, but Git kept
    // its linked-worktree registration for this exact version path.
    rmSync(target, { recursive: true, force: true })
    expect(git(repository, ['worktree', 'list', '--porcelain'])).toContain('prunable')

    await materializeLauncherVersion(
      'git',
      repository,
      versions,
      pointer,
      targetCommit,
      steps(async (directory) => {
        const builtEntry = path.join(directory, 'apps', 'cli', 'lib', 'bin.js')
        mkdirSync(path.dirname(builtEntry), { recursive: true })
        writeFileSync(builtEntry, 'process.stdout.write("built")\n')
      })
    )

    expect(await readCurrentVersionPointer(pointer)).toBe(targetCommit)
    expect(existsSync(path.join(target, 'apps', 'cli', 'lib', 'bin.js'))).toBe(true)
    const registrations = git(repository, ['worktree', 'list', '--porcelain'])
    expect(registrations).toContain(`worktree ${repository}`)
    expect(registrations).toContain(`worktree ${target}`)
    expect(registrations).not.toContain('prunable')
  })

  it('removes previous version packages only after the new version is active', async () => {
    const { repository, versions, pointer, previousCommit, targetCommit } = createRepository()
    const previousDirectory = versionDirectory(versions, previousCommit)
    const activeDirectory = versionDirectory(versions, targetCommit)
    const unrelatedDirectory = path.join(path.dirname(versions), 'unrelated-data')
    mkdirSync(unrelatedDirectory)
    writeFileSync(path.join(unrelatedDirectory, 'keep.txt'), 'preserve')
    git(repository, ['worktree', 'add', '--detach', previousDirectory, previousCommit])
    git(repository, ['worktree', 'add', '--detach', activeDirectory, targetCommit])
    await writeCurrentVersionPointer(pointer, targetCommit)

    await pruneInactiveVersions('git', repository, versions, targetCommit, () => undefined)

    expect(existsSync(previousDirectory)).toBe(false)
    expect(existsSync(activeDirectory)).toBe(true)
    expect(readFileSync(path.join(unrelatedDirectory, 'keep.txt'), 'utf8')).toBe('preserve')
    const registrations = git(repository, ['worktree', 'list', '--porcelain'])
    expect(registrations).toContain(`worktree ${repository}`)
    expect(registrations).toContain(`worktree ${activeDirectory}`)
    expect(registrations).not.toContain(`worktree ${previousDirectory}`)
  })
})
