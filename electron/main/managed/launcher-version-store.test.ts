import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LAUNCHER_VERSION_POINTER_FORMAT,
  assertLauncherVersionCheckout,
  materializeLauncherVersion,
  readCurrentVersionPointer,
  writeCurrentVersionPointer
} from './launcher-version-store'

const roots: string[] = []
const masterReference = 'refs/remotes/origin/master'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(repository: string, arguments_: readonly string[]): string {
  return execFileSync('git', ['-C', repository, ...arguments_], {
    encoding: 'utf8',
    windowsHide: true
  }).trim()
}

function write(directory: string, relativePath: string, contents: string): void {
  const file = path.join(directory, relativePath)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

function commit(repository: string, source: string): string {
  write(repository, 'src/example.ts', source)
  git(repository, ['add', '--all'])
  git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', source])
  return git(repository, ['rev-parse', 'HEAD'])
}

function createRepository() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'launcher-version-store-')))
  roots.push(root)
  const repository = path.join(root, 'harness')
  const versions = path.join(root, 'versions')
  mkdirSync(repository)
  mkdirSync(versions)
  git(repository, ['init', '--initial-branch=master'])
  git(repository, ['config', 'user.name', 'Launcher Test'])
  git(repository, ['config', 'user.email', 'launcher-test@example.invalid'])
  git(repository, ['config', 'core.autocrlf', 'false'])
  write(repository, '.gitignore', 'node_modules/\napps/cli/lib/\n')
  write(repository, 'package.json', '{"name":"harness-test"}\n')
  const previousCommit = commit(repository, 'export const version = "previous"\n')
  const targetCommit = commit(repository, 'export const version = "target"\n')
  git(repository, ['update-ref', masterReference, targetCommit])
  return {
    root,
    repository,
    versions,
    pointer: path.join(root, 'current-version.json'),
    previousCommit,
    targetCommit
  }
}

function readyArtifacts(directory: string): void {
  write(directory, 'apps/cli/lib/bin.js', 'process.stdout.write("built")\n')
  write(directory, 'node_modules/tsx/package.json', '{"name":"tsx"}\n')
}

function steps(
  build: (directory: string) => Promise<void> = async (directory) => readyArtifacts(directory)
) {
  return {
    loggedStep: async <T>(_description: string, step: () => Promise<T>): Promise<T> => step(),
    install: vi.fn(async (_directory: string) => undefined),
    build: vi.fn(build),
    reconcilePlugins: vi.fn(async (_directory: string) => undefined),
    validate: vi.fn(async (_directory: string) => undefined),
    event: vi.fn()
  }
}

function switchVersion(
  fixture: ReturnType<typeof createRepository>,
  commit: string,
  operations = steps(),
  branch: string | null = null
): Promise<void> {
  return materializeLauncherVersion(
    'git',
    fixture.repository,
    fixture.versions,
    fixture.pointer,
    {
      commit,
      branch,
      reference: branch === null ? masterReference : `refs/remotes/origin/${branch}`
    },
    operations
  )
}

describe('switching DSH versions in the selected checkout', () => {
  it('builds a fresh installation in the existing repository and preserves its caches and local refs', async () => {
    const fixture = createRepository()
    const { repository, versions, pointer, targetCommit } = fixture
    const cachedDependency = 'node_modules/cached-package/keep'
    write(repository, cachedDependency, 'cache')
    const operations = steps()

    await switchVersion(fixture, targetCommit, operations)
    expect(await readCurrentVersionPointer(pointer)).toEqual({
      status: 'ready',
      checkout: 'repository',
      commit: targetCommit,
      branch: null
    })
    expect(git(repository, ['rev-parse', 'HEAD'])).toBe(targetCommit)
    expect(git(repository, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD')
    expect(operations.install).toHaveBeenCalledWith(repository)
    expect(operations.build).toHaveBeenCalledWith(repository)
    expect(operations.reconcilePlugins).toHaveBeenCalledWith(repository)
    expect(operations.validate).toHaveBeenCalledWith(repository)
    expect(readFileSync(path.join(repository, cachedDependency), 'utf8')).toBe('cache')
    expect(git(repository, ['rev-parse', 'refs/heads/master'])).toBe(targetCommit)
    expect(readdirSync(versions)).toEqual([])
  })

  it('keeps the original linked worktree path and installed dependencies across repeated switches', async () => {
    const fixture = createRepository()
    const { repository, versions, pointer, previousCommit, targetCommit } = fixture
    const active = path.join(versions, previousCommit)
    git(repository, ['worktree', 'add', '--detach', active, previousCommit])
    write(active, 'node_modules/cached-package/keep', 'original worktree cache')
    readyArtifacts(active)
    await writeCurrentVersionPointer(pointer, { status: 'legacy', commit: previousCommit })
    const operations = steps()

    await switchVersion(fixture, targetCommit, operations)
    expect(await readCurrentVersionPointer(pointer)).toEqual({
      status: 'ready',
      checkout: previousCommit,
      commit: targetCommit,
      branch: null
    })
    expect(git(active, ['rev-parse', 'HEAD'])).toBe(targetCommit)

    await switchVersion(fixture, previousCommit, operations)
    expect(await readCurrentVersionPointer(pointer)).toMatchObject({
      status: 'ready',
      checkout: previousCommit
    })
    expect(git(active, ['rev-parse', 'HEAD'])).toBe(previousCommit)
    expect(operations.install.mock.calls).toEqual([[active], [active]])
    expect(readFileSync(path.join(active, 'node_modules/cached-package/keep'), 'utf8')).toBe(
      'original worktree cache'
    )
    expect(readdirSync(versions)).toEqual([previousCommit])
  })

  it('retries the same HEAD after interrupted preparation even when runnable-looking files exist', async () => {
    const fixture = createRepository()
    const { repository, pointer, previousCommit, targetCommit } = fixture
    await switchVersion(fixture, previousCommit)
    const failedOperations = steps(async (directory) => {
      readyArtifacts(directory)
      throw new Error('native build interrupted')
    })

    await expect(switchVersion(fixture, targetCommit, failedOperations)).rejects.toThrow(
      'native build interrupted'
    )
    expect(git(repository, ['rev-parse', 'HEAD'])).toBe(targetCommit)
    expect(await readCurrentVersionPointer(pointer)).toMatchObject({
      status: 'preparing',
      commit: targetCommit
    })

    const retryOperations = steps()
    await switchVersion(fixture, targetCommit, retryOperations)
    expect(retryOperations.install).toHaveBeenCalledWith(repository)
    expect(retryOperations.build).toHaveBeenCalledWith(repository)
    expect(await readCurrentVersionPointer(pointer)).toMatchObject({
      status: 'ready',
      commit: targetCommit
    })
  })

  it('rebuilds the selected version when its dependency tree no longer resolves', async () => {
    const fixture = createRepository()
    const { repository, pointer, targetCommit } = fixture
    await switchVersion(fixture, targetCommit)
    rmSync(path.join(repository, 'node_modules', 'tsx'), { recursive: true })
    const operations = steps()

    await switchVersion(fixture, targetCommit, operations)
    expect(operations.install).toHaveBeenCalledWith(repository)
    expect(operations.build).toHaveBeenCalledWith(repository)
    expect(await readCurrentVersionPointer(pointer)).toMatchObject({
      status: 'ready',
      commit: targetCommit
    })
  })

  it.each(['staged', 'unstaged'])(
    'protects %s changes to tracked files before writing the pointer',
    async (state) => {
      const fixture = createRepository()
      const { repository, pointer, previousCommit, targetCommit } = fixture
      const file = 'src/example.ts'
      await switchVersion(fixture, targetCommit)
      write(repository, file, 'local content')
      if (state === 'staged') git(repository, ['add', file])
      const gitStatus = git(repository, ['status', '--porcelain'])
      const operations = steps()

      await expect(switchVersion(fixture, previousCommit, operations)).rejects.toMatchObject({
        code: 'git.repository_dirty'
      })
      expect(readFileSync(path.join(repository, file), 'utf8')).toBe('local content')
      expect(git(repository, ['status', '--porcelain'])).toBe(gitStatus)
      expect(git(repository, ['rev-parse', 'HEAD'])).toBe(targetCommit)
      expect(await readCurrentVersionPointer(pointer)).toMatchObject({
        status: 'ready',
        commit: targetCommit
      })
      expect(operations.install).not.toHaveBeenCalled()
    }
  )

  it('preserves untracked files when switching across revisions with different ignore rules', async () => {
    const fixture = createRepository()
    const { repository, targetCommit } = fixture
    const generated = '.dsh-build/record.json'
    write(repository, '.gitignore', 'node_modules/\napps/cli/lib/\n.dsh-build/\n')
    const newerCommit = commit(repository, 'export const version = "newer"\n')
    git(repository, ['update-ref', masterReference, newerCommit])
    await switchVersion(fixture, newerCommit)
    write(repository, generated, 'cached build record')
    write(repository, 'local-notes.txt', 'local notes')

    await switchVersion(fixture, targetCommit)
    expect(git(repository, ['status', '--porcelain', '--untracked-files=all'])).toContain(
      '.dsh-build/record.json'
    )
    await switchVersion(fixture, newerCommit)

    expect(git(repository, ['rev-parse', 'HEAD'])).toBe(newerCommit)
    expect(readFileSync(path.join(repository, generated), 'utf8')).toBe('cached build record')
    expect(readFileSync(path.join(repository, 'local-notes.txt'), 'utf8')).toBe('local notes')
  })

  it.each(['apps/cli/lib/custom.js', 'custom.js'])(
    'preserves %s when the selected commit would replace a local file',
    async (collidingFile) => {
      const fixture = createRepository()
      const { repository, targetCommit } = fixture
      write(repository, collidingFile, 'tracked in the new version')
      git(repository, ['add', '--force', collidingFile])
      git(repository, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'Track former ignored path'])
      const collidingCommit = git(repository, ['rev-parse', 'HEAD'])
      git(repository, ['update-ref', masterReference, collidingCommit])
      await switchVersion(fixture, targetCommit)
      write(repository, collidingFile, 'existing local content')
      const operations = steps()

      await expect(switchVersion(fixture, collidingCommit, operations)).rejects.toMatchObject({
        code: 'runtime.worktree_invalid'
      })
      expect(git(repository, ['rev-parse', 'HEAD'])).toBe(targetCommit)
      expect(readFileSync(path.join(repository, collidingFile), 'utf8')).toBe(
        'existing local content'
      )
      expect(operations.install).not.toHaveBeenCalled()
    }
  )

  it('selects a locally fetched branch tip outside master only through its own remote ref', async () => {
    const fixture = createRepository()
    const { repository, pointer, previousCommit, targetCommit } = fixture
    git(repository, ['switch', '--detach', previousCommit])
    const branchCommit = commit(repository, 'export const version = "integration"\n')
    git(repository, ['update-ref', 'refs/remotes/origin/integration', branchCommit])
    git(repository, ['switch', 'master'])

    await expect(switchVersion(fixture, branchCommit)).rejects.toMatchObject({
      code: 'runtime.input_invalid'
    })
    expect(await readCurrentVersionPointer(pointer)).toBeUndefined()

    await switchVersion(fixture, branchCommit, steps(), 'integration')
    expect(await readCurrentVersionPointer(pointer)).toMatchObject({
      status: 'ready',
      commit: branchCommit,
      branch: 'integration'
    })
    expect(git(repository, ['rev-parse', 'HEAD'])).toBe(branchCommit)
    expect(git(repository, ['rev-parse', 'refs/heads/master'])).toBe(targetCommit)
  })

  it('refuses a ready checkout whose HEAD moved outside the Launcher', async () => {
    const fixture = createRepository()
    const { repository, previousCommit, targetCommit } = fixture
    await switchVersion(fixture, previousCommit)
    git(repository, ['switch', '--detach', targetCommit])

    await expect(
      assertLauncherVersionCheckout('git', repository, repository, previousCommit)
    ).rejects.toMatchObject({ code: 'runtime.worktree_invalid' })
  })

  it('refuses a persisted checkout outside the registered version directories', async () => {
    const fixture = createRepository()
    const { pointer, previousCommit, targetCommit } = fixture
    writeFileSync(
      pointer,
      JSON.stringify({
        format: LAUNCHER_VERSION_POINTER_FORMAT,
        status: 'ready',
        commit: previousCommit,
        checkout: '../outside',
        branch: null
      })
    )
    const operations = steps()

    await expect(switchVersion(fixture, targetCommit, operations)).rejects.toMatchObject({
      code: 'runtime.version_pointer_invalid'
    })
    expect(operations.install).not.toHaveBeenCalled()
  })

  it('refuses a matching SHA in a worktree attached to a different Git repository', async () => {
    const fixture = createRepository()
    const { root, repository, versions, pointer, previousCommit, targetCommit } = fixture
    const foreignRepository = path.join(root, 'foreign')
    const foreignWorktree = path.join(versions, previousCommit)
    git(root, ['clone', '--local', repository, foreignRepository])
    git(foreignRepository, ['worktree', 'add', '--detach', foreignWorktree, previousCommit])
    await writeCurrentVersionPointer(pointer, { status: 'legacy', commit: previousCommit })
    const operations = steps()

    await expect(switchVersion(fixture, targetCommit, operations)).rejects.toMatchObject({
      code: 'runtime.worktree_invalid'
    })
    expect(git(foreignWorktree, ['rev-parse', 'HEAD'])).toBe(previousCommit)
    expect(await readCurrentVersionPointer(pointer)).toEqual({
      status: 'legacy',
      commit: previousCommit
    })
    expect(operations.install).not.toHaveBeenCalled()
  })
})
