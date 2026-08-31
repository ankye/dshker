import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitRuntimeError } from './errors'
import {
  acquireManagedGitOperationLock,
  createManagedGitInstallationPaths,
  ensureManagedGitInstallationDirectories,
  managedWorktreePath
} from './paths'

describe('managed Git filesystem layout', () => {
  it('derives mirror, staging, locks, and exact-SHA worktrees only below the registered namespace', async () => {
    const namespacePath = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-layout-'))
    )
    const paths = createManagedGitInstallationPaths(namespacePath, 'installation_main')
    await ensureManagedGitInstallationDirectories(paths)

    expect(paths.mirrorPath.startsWith(`${namespacePath}${nodePath.sep}`)).toBe(true)
    expect(managedWorktreePath(paths, '0123456789abcdef0123456789abcdef01234567')).toBe(
      nodePath.join(paths.worktreesPath, '0123456789abcdef0123456789abcdef01234567')
    )
    expect(() => managedWorktreePath(paths, '../escape')).toThrow(GitRuntimeError)
  })

  it('refuses a concurrent operation rather than stealing or deleting its lock', async () => {
    const namespacePath = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-lock-'))
    )
    const paths = createManagedGitInstallationPaths(namespacePath, 'installation_main')
    const first = await acquireManagedGitOperationLock(paths)

    await expect(acquireManagedGitOperationLock(paths)).rejects.toMatchObject({
      code: 'git.operation_locked'
    })
    await first.release()
    const second = await acquireManagedGitOperationLock(paths)
    await second.release()
  })
})
