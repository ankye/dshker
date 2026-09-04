import { lstat, readFile } from 'node:fs/promises'
import nodePath from 'node:path'
import type {
  LauncherHarnessCommitView,
  LauncherHarnessPluginView,
  LauncherHarnessVersionView
} from '../../../src/shared/contracts'
import { assertDirectDirectory, assertDirectRegularFile, runText } from './process-utils'
import { launcherGitArguments } from './launcher-harness-commands'
import { ManagedPluginSources } from './managed-plugin-sources'
import {
  gitUrlOf,
  localPathOf,
  normalizeGitRemote,
  parseProfilePluginRecords
} from './profile-plugins'

/** Checkout readiness as the launcher reports it; `missing` and `invalid` carry the reason. */
export type HarnessReadiness =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'missing' | 'invalid'
      readonly harnessDirectory: string
      readonly message: string
    }

/**
 * Proves the checkout is a direct directory holding the manifest and the built
 * DSH CLI entry. Read-only: it never creates or repairs.
 *
 * The Git entry is accepted as either a directory (a plain repository) or a
 * regular file (a `git worktree` pointer file), because every per-version
 * directory is a worktree of the main repository.
 */
export async function readHarnessReadiness(harnessDirectory: string): Promise<HarnessReadiness> {
  try {
    await assertDirectDirectory(harnessDirectory)
  } catch (error) {
    if (isMissing(error)) {
      return {
        kind: 'missing',
        harnessDirectory,
        message: 'The Launcher Harness directory has not been initialized.'
      }
    }
    return {
      kind: 'invalid',
      harnessDirectory,
      message: 'The Launcher Harness directory is not a direct directory.'
    }
  }
  try {
    const gitEntry = nodePath.join(harnessDirectory, '.git')
    await Promise.all([
      assertDirectRegularFile(nodePath.join(harnessDirectory, 'package.json')),
      assertDirectRegularFile(nodePath.join(harnessDirectory, 'apps', 'cli', 'lib', 'bin.js'))
    ])
    const gitMetadata = await lstat(gitEntry)
    if (gitMetadata.isSymbolicLink()) throw new Error('Not a repository entry.')
    if (!gitMetadata.isFile() && !gitMetadata.isDirectory()) {
      throw new Error('Not a repository entry.')
    }
    return { kind: 'ready' }
  } catch {
    return {
      kind: 'invalid',
      harnessDirectory,
      message: 'The Launcher Harness directory is missing its built DSH checkout.'
    }
  }
}

/** Checkout metadata that survives an unbuilt checkout; absent keys mean unreadable. */
export interface LauncherCheckoutMetadata {
  readonly remoteUrl?: string
  readonly currentBranch?: string
  readonly branches: readonly string[]
  readonly revision: string | undefined
  readonly commits: readonly LauncherHarnessCommitView[]
  readonly stableVersions: readonly LauncherHarnessVersionView[]
}

/**
 * Reads checkout metadata best-effort for a not-ready checkout.
 *
 * An interrupted switch removes build artifacts, not Git history; keeping the
 * version list readable is what lets the user recover by switching again.
 * Every Git failure collapses to empty values instead of failing the state.
 */
export async function tryReadLauncherCheckoutMetadata(
  gitExecutable: string,
  harnessDirectory: string
): Promise<LauncherCheckoutMetadata> {
  try {
    const [remoteUrl, currentBranch, branches, revision, commits, stableVersions] =
      await Promise.all([
        runText(
          gitExecutable,
          launcherGitArguments(['-C', harnessDirectory, 'remote', 'get-url', 'origin'])
        ).then((value) => value.trim()),
        readLauncherCurrentBranch(gitExecutable, harnessDirectory),
        readLauncherBranches(gitExecutable, harnessDirectory),
        runText(
          gitExecutable,
          launcherGitArguments(['-C', harnessDirectory, 'rev-parse', 'HEAD'])
        ).then((value) => value.trim()),
        readLauncherCommits(gitExecutable, harnessDirectory, 'origin/master'),
        readLauncherStableVersions(gitExecutable, harnessDirectory)
      ])
    return { remoteUrl, currentBranch, branches, revision, commits, stableVersions }
  } catch {
    return { branches: [], revision: undefined, commits: [], stableVersions: [] }
  }
}

/**
 * Proves the Git repository exists for version operations.
 *
 * Switching and fetching need history and refs, not the built artifact, so an
 * unbuilt checkout can still be repaired by running a switch again.
 */
export async function assertLauncherGitRepository(harnessDirectory: string): Promise<void> {
  await assertDirectDirectory(harnessDirectory)
  await assertDirectDirectory(nodePath.join(harnessDirectory, '.git'))
}

/** Reads the Launcher-owned Harness checkout for `getState`; it never mutates it. */

export async function readLauncherCommits(
  gitExecutable: string,
  harnessDirectory: string,
  reference: string
): Promise<readonly LauncherHarnessCommitView[]> {
  const output = await runText(
    gitExecutable,
    launcherGitArguments([
      '-C',
      harnessDirectory,
      'log',
      '--max-count=100',
      '--format=%H%x1f%ct%x1f%s',
      reference
    ])
  )
  return output
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash, committedAt, subject] = line.split('\u001f')
      if (!hash || !committedAt || subject === undefined || !/^[0-9a-f]{40}$/u.test(hash)) {
        throw new Error('The bundled Harness Git history is invalid.')
      }
      const milliseconds = Number(committedAt) * 1000
      if (!Number.isSafeInteger(milliseconds))
        throw new Error('The bundled Harness Git history is invalid.')
      return { hash, subject, committedAt: milliseconds }
    })
}

export async function readLauncherStableVersions(
  gitExecutable: string,
  harnessDirectory: string
): Promise<readonly LauncherHarnessVersionView[]> {
  const tags = (
    await runText(
      gitExecutable,
      launcherGitArguments([
        '-C',
        harnessDirectory,
        'tag',
        '--merged',
        'origin/master',
        '--sort=-creatordate'
      ])
    )
  )
    .trim()
    .split('\n')
    .filter((tag) => tag.length > 0)
    .slice(0, 100)
  return Promise.all(
    tags.map(async (tag) => {
      const [commit] = await readLauncherCommits(gitExecutable, harnessDirectory, tag)
      if (commit === undefined) throw new Error('The bundled Harness release tag is invalid.')
      return { ...commit, tag }
    })
  )
}

export async function readLauncherCurrentBranch(
  gitExecutable: string,
  harnessDirectory: string
): Promise<string> {
  const branch = (
    await runText(
      gitExecutable,
      launcherGitArguments(['-C', harnessDirectory, 'branch', '--show-current'])
    )
  ).trim()
  return branch.length === 0 ? 'master' : branch
}

export async function readLauncherBranches(
  gitExecutable: string,
  harnessDirectory: string
): Promise<readonly string[]> {
  const output = await runText(
    gitExecutable,
    launcherGitArguments([
      '-C',
      harnessDirectory,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/remotes/origin'
    ])
  )
  return output
    .trim()
    .split('\n')
    .filter((reference) => reference.startsWith('origin/') && reference !== 'origin/HEAD')
    .map((reference) => reference.slice('origin/'.length))
    .sort((left, right) => left.localeCompare(right))
}

/**
 * Reads the native DSH web profile's plugin records and joins them with the
 * Launcher's managed-source map. The profile stays the installation authority;
 * this view never writes it.
 */
export async function readProfilePluginViews(
  gitExecutable: string,
  dshHomeDirectory: string,
  pluginSources: ManagedPluginSources
): Promise<readonly LauncherHarnessPluginView[]> {
  const packagePath = nodePath.join(dshHomeDirectory, 'profiles', 'web', 'package.json')
  try {
    await assertDirectRegularFile(packagePath)
  } catch (error) {
    if (isMissing(error)) return []
    throw new Error('The native DSH web profile package record is invalid.')
  }
  const content = await readFile(packagePath, 'utf8')
  const [views, managedGitSources] = await Promise.all([
    Promise.resolve(parseProfilePluginRecords(JSON.parse(content))),
    pluginSources.gitSources()
  ])
  // A `file:` dependency carries no git source in the manifest, so the remote
  // is read from the checkout it points at. Resolution is best-effort: a
  // plugin whose checkout is gone still lists with its name and version.
  return Promise.all(
    views.map(async (view) => {
      const resolved = await withResolvedSource(gitExecutable, view)
      const managedGitSource = managedGitSources.get(view.name)
      return managedGitSource === undefined
        ? resolved
        : {
            ...resolved,
            managedGitSource: {
              revision: managedGitSource.revision,
              updateAvailable: managedGitSource.updateAvailable,
              ...(managedGitSource.branch === undefined ? {} : { branch: managedGitSource.branch })
            }
          }
    })
  )
}

/** Adds the git remote and local path for a `file:` dependency, when readable. */
async function withResolvedSource(
  gitExecutable: string,
  view: LauncherHarnessPluginView
): Promise<LauncherHarnessPluginView> {
  const localPath = localPathOf(view.version)
  if (localPath === undefined) {
    const direct = gitUrlOf(view.version)
    return direct === undefined ? view : { ...view, sourceUrl: direct }
  }
  try {
    const remote = (
      await runText(
        gitExecutable,
        launcherGitArguments(['-C', localPath, 'remote', 'get-url', 'origin'])
      )
    ).trim()
    const normalized = normalizeGitRemote(remote)
    return {
      ...view,
      localPath,
      ...(normalized === undefined ? {} : { sourceUrl: normalized })
    }
  } catch {
    return { ...view, localPath }
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
