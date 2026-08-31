import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises'
import nodePath from 'node:path'
import { GitRuntimeError, gitRuntimeFailure } from './errors'
import type { ManagedGitInstallationPaths } from './types'

const INSTALLATION_ID = /^[a-z][a-z0-9_-]{2,127}$/

/** Builds the fixed, launcher-owned Git layout below an already-validated Harness namespace. */
export function createManagedGitInstallationPaths(
  namespacePath: string,
  installationId: string
): ManagedGitInstallationPaths {
  assertCanonicalAbsolutePath(namespacePath, 'Managed Harness namespace')
  if (!INSTALLATION_ID.test(installationId)) {
    throw new GitRuntimeError('git.managed_path_invalid', 'Managed installation id is invalid.')
  }
  const installationPath = nodePath.join(
    namespacePath,
    'dsh-launcher',
    'managed-installations',
    installationId
  )
  const paths: ManagedGitInstallationPaths = {
    installationId,
    namespacePath,
    installationPath,
    mirrorPath: nodePath.join(installationPath, 'mirror.git'),
    worktreesPath: nodePath.join(installationPath, 'worktrees'),
    stagingPath: nodePath.join(installationPath, 'staging'),
    lockPath: nodePath.join(installationPath, 'operation.lock')
  }
  for (const candidate of [
    paths.installationPath,
    paths.mirrorPath,
    paths.worktreesPath,
    paths.stagingPath,
    paths.lockPath
  ]) {
    assertContainedManagedPath(paths, candidate)
  }
  return paths
}

/** Creates only the fixed launcher-owned parent directories, rejecting symlinks and unexpected files. */
export async function ensureManagedGitInstallationDirectories(
  paths: ManagedGitInstallationPaths
): Promise<void> {
  await assertCanonicalExistingDirectory(paths.namespacePath, 'Managed Harness namespace')
  await ensureDirectoryBelow(
    paths.namespacePath,
    nodePath.join(paths.namespacePath, 'dsh-launcher')
  )
  await ensureDirectoryBelow(
    paths.namespacePath,
    nodePath.join(paths.namespacePath, 'dsh-launcher', 'managed-installations')
  )
  await ensureDirectoryBelow(paths.namespacePath, paths.installationPath)
  await ensureDirectoryBelow(paths.namespacePath, paths.worktreesPath)
  await ensureDirectoryBelow(paths.namespacePath, paths.stagingPath)
}

/** Proves that an existing target is a direct, non-symlink child of the managed installation. */
export async function assertManagedGitTarget(
  paths: ManagedGitInstallationPaths,
  target: string,
  subject: string
): Promise<void> {
  assertContainedManagedPath(paths, target)
  let metadata
  try {
    metadata = await lstat(target)
  } catch (error) {
    throw gitRuntimeFailure('git.managed_path_invalid', `${subject} is unavailable.`, error, {
      installationId: paths.installationId
    })
  }
  if (metadata.isSymbolicLink()) {
    throw new GitRuntimeError(
      'git.managed_path_escape',
      `${subject} must not be a symbolic link.`,
      {
        installationId: paths.installationId
      }
    )
  }
  let canonicalTarget: string
  try {
    canonicalTarget = await realpath(target)
  } catch (error) {
    throw gitRuntimeFailure(
      'git.managed_path_invalid',
      `${subject} cannot be canonicalized.`,
      error,
      {
        installationId: paths.installationId
      }
    )
  }
  if (canonicalTarget !== target || !isStrictlyInside(paths.namespacePath, canonicalTarget)) {
    throw new GitRuntimeError(
      'git.managed_path_escape',
      `${subject} escapes the managed Harness namespace.`,
      {
        installationId: paths.installationId
      }
    )
  }
}

/** Acquires a non-stealable, launcher-owned operation lock for one managed installation. */
export async function acquireManagedGitOperationLock(
  paths: ManagedGitInstallationPaths
): Promise<ManagedGitOperationLock> {
  await ensureManagedGitInstallationDirectories(paths)
  try {
    await mkdir(paths.lockPath, { mode: 0o700 })
  } catch (error) {
    if (isNodeCode(error, 'EEXIST')) {
      throw new GitRuntimeError(
        'git.operation_locked',
        'A managed Git operation is already in progress.',
        {
          installationId: paths.installationId
        }
      )
    }
    throw gitRuntimeFailure(
      'git.operation_failed',
      'Managed Git operation lock could not be created.',
      error,
      {
        installationId: paths.installationId
      }
    )
  }

  const ownerId = randomUUID()
  const ownerPath = nodePath.join(paths.lockPath, 'owner.json')
  try {
    await writeFile(ownerPath, JSON.stringify({ ownerId }) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
  } catch (error) {
    await rmdir(paths.lockPath).catch(() => undefined)
    throw gitRuntimeFailure(
      'git.operation_failed',
      'Managed Git operation lock could not record its owner.',
      error,
      {
        installationId: paths.installationId
      }
    )
  }
  return new ManagedGitOperationLock(paths, ownerId, ownerPath)
}

/** Owns release of exactly the lock directory created by this process. */
export class ManagedGitOperationLock {
  readonly #paths: ManagedGitInstallationPaths
  readonly #ownerId: string
  readonly #ownerPath: string
  #released = false

  constructor(paths: ManagedGitInstallationPaths, ownerId: string, ownerPath: string) {
    this.#paths = paths
    this.#ownerId = ownerId
    this.#ownerPath = ownerPath
  }

  /** Releases the lock only when its owner record still belongs to this instance. */
  async release(): Promise<void> {
    if (this.#released) {
      throw new GitRuntimeError(
        'git.operation_lock_lost',
        'Managed Git operation lock was already released.',
        {
          installationId: this.#paths.installationId
        }
      )
    }
    let text: string
    try {
      text = await readFile(this.#ownerPath, 'utf8')
    } catch (error) {
      throw gitRuntimeFailure(
        'git.operation_lock_lost',
        'Managed Git operation lock owner record is unavailable.',
        error,
        {
          installationId: this.#paths.installationId
        }
      )
    }
    if (text !== `${JSON.stringify({ ownerId: this.#ownerId })}\n`) {
      throw new GitRuntimeError(
        'git.operation_lock_lost',
        'Managed Git operation lock owner changed.',
        {
          installationId: this.#paths.installationId
        }
      )
    }
    try {
      await unlink(this.#ownerPath)
      await rmdir(this.#paths.lockPath)
    } catch (error) {
      throw gitRuntimeFailure(
        'git.operation_lock_lost',
        'Managed Git operation lock could not be released.',
        error,
        {
          installationId: this.#paths.installationId
        }
      )
    }
    this.#released = true
  }
}

/** Returns an exact detached-worktree path only for a full resolved commit SHA. */
export function managedWorktreePath(paths: ManagedGitInstallationPaths, commit: string): string {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new GitRuntimeError(
      'git.ref_invalid',
      'Managed worktree requires a full lowercase commit SHA.'
    )
  }
  const target = nodePath.join(paths.worktreesPath, commit)
  assertContainedManagedPath(paths, target)
  return target
}

/** Asserts that an arbitrary supplied path remains below the authoritative namespace. */
export function assertContainedManagedPath(
  paths: ManagedGitInstallationPaths,
  target: string
): void {
  assertCanonicalAbsolutePath(target, 'Managed Git path')
  if (!isStrictlyInside(paths.namespacePath, target)) {
    throw new GitRuntimeError(
      'git.managed_path_escape',
      'Managed Git path escapes the Harness namespace.',
      {
        installationId: paths.installationId
      }
    )
  }
}

async function ensureDirectoryBelow(namespacePath: string, target: string): Promise<void> {
  if (!isStrictlyInside(namespacePath, target)) {
    throw new GitRuntimeError(
      'git.managed_path_escape',
      'Managed Git directory escapes the Harness namespace.'
    )
  }
  const relative = nodePath.relative(namespacePath, target)
  const segments = relative.split(nodePath.sep)
  let cursor = namespacePath
  for (const segment of segments) {
    cursor = nodePath.join(cursor, segment)
    try {
      const metadata = await lstat(cursor)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new GitRuntimeError(
          'git.managed_path_escape',
          'Managed Git directory is not a direct directory.'
        )
      }
    } catch (error) {
      if (error instanceof GitRuntimeError) throw error
      if (!isNodeCode(error, 'ENOENT')) {
        throw gitRuntimeFailure(
          'git.operation_failed',
          'Managed Git directory could not be inspected.',
          error
        )
      }
      try {
        await mkdir(cursor, { mode: 0o700 })
      } catch (createError) {
        throw gitRuntimeFailure(
          'git.operation_failed',
          'Managed Git directory could not be created.',
          createError
        )
      }
      try {
        const created = await lstat(cursor)
        if (!created.isDirectory() || created.isSymbolicLink()) {
          throw new GitRuntimeError(
            'git.managed_path_escape',
            'Managed Git directory changed during creation.'
          )
        }
      } catch (verifyError) {
        if (verifyError instanceof GitRuntimeError) throw verifyError
        throw gitRuntimeFailure(
          'git.operation_failed',
          'Managed Git directory could not be verified after creation.',
          verifyError
        )
      }
    }
  }
}

async function assertCanonicalExistingDirectory(path: string, subject: string): Promise<void> {
  assertCanonicalAbsolutePath(path, subject)
  let metadata
  let canonicalPath: string
  try {
    metadata = await lstat(path)
    canonicalPath = await realpath(path)
  } catch (error) {
    throw gitRuntimeFailure('git.managed_path_invalid', `${subject} is unavailable.`, error)
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonicalPath !== path) {
    throw new GitRuntimeError(
      'git.managed_path_invalid',
      `${subject} must be an existing canonical directory.`
    )
  }
}

function assertCanonicalAbsolutePath(value: unknown, subject: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\u0000') ||
    !nodePath.isAbsolute(value)
  ) {
    throw new GitRuntimeError('git.managed_path_invalid', `${subject} must be an absolute path.`)
  }
  if (nodePath.normalize(value) !== value || nodePath.parse(value).root === value) {
    throw new GitRuntimeError(
      'git.managed_path_invalid',
      `${subject} must be canonical and non-root.`
    )
  }
}

function isStrictlyInside(parent: string, child: string): boolean {
  const relative = nodePath.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !nodePath.isAbsolute(relative)
}

function isNodeCode(value: unknown, expected: string): boolean {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === expected)
}
