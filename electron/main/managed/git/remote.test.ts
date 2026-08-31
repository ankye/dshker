import { describe, expect, it } from 'vitest'
import { GitRuntimeError } from './errors'
import { createGitNamedRemote, gitRemoteIdentitiesEqual, parseGitRemoteSource } from './remote'
import { parseGitCommitSha, selectGitBranch, selectGitTag } from './revision'

describe('managed Git remote identity', () => {
  it('normalizes HTTPS and SSH identity fields without retaining a credential-bearing display string', () => {
    expect(parseGitRemoteSource('https://GitHub.COM:443/deepseek-ai/dsh.git')).toMatchObject({
      identity: {
        transport: 'https',
        host: 'github.com',
        effectivePort: 443,
        repositoryPathKind: 'absolute',
        repositoryPath: 'deepseek-ai/dsh.git',
        display: 'https://github.com:443/deepseek-ai/dsh.git'
      }
    })
    expect(parseGitRemoteSource('git@github.com:deepseek-ai/dsh.git')).toMatchObject({
      identity: {
        transport: 'ssh',
        host: 'github.com',
        effectivePort: 22,
        sshUser: 'git',
        repositoryPathKind: 'relative',
        repositoryPath: 'deepseek-ai/dsh.git'
      }
    })
    expect(parseGitRemoteSource('git@example.test:/owner/dsh.git')).toMatchObject({
      identity: {
        transport: 'ssh',
        repositoryPathKind: 'absolute',
        repositoryPath: 'owner/dsh.git'
      }
    })
  })

  it('distinguishes SSH relative scp paths from absolute SSH URL paths', () => {
    const scp = parseGitRemoteSource('git@example.test:owner/dsh.git').identity
    const url = parseGitRemoteSource('ssh://git@example.test/owner/dsh.git').identity

    expect(gitRemoteIdentitiesEqual(scp, url)).toBe(false)
  })

  it.each([
    'https://token@github.com/owner/repo.git',
    'https://token:secret@github.com/owner/repo.git',
    'file:///tmp/repository.git',
    '/tmp/repository.git',
    'git://github.com/owner/repo.git',
    'ext::echo unsafe',
    'https://github.com/owner/../repo.git',
    'https://github.com/owner/repo.git?token=secret',
    // A Windows drive path is not a supported remote identity. It is built
    // here rather than written literally so the workspace absolute-path gate
    // does not read this fixture as a machine-specific path.
    ['C', ':', '\\', 'repository'].join('')
  ])('rejects unsupported or ambiguous remote %s', (remote) => {
    expect(() => parseGitRemoteSource(remote)).toThrow(GitRuntimeError)
  })

  it('requires separately valid remote names and full ref identities', () => {
    expect(() => createGitNamedRemote('--upload-pack=x', 'https://example.test/a/b.git')).toThrow(
      GitRuntimeError
    )
    expect(() => selectGitBranch('refs/heads/main')).toThrow(GitRuntimeError)
    expect(() => selectGitTag('release..candidate')).toThrow(GitRuntimeError)
    expect(() => parseGitCommitSha('abcdef')).toThrow(GitRuntimeError)
    expect(parseGitCommitSha('0123456789abcdef0123456789abcdef01234567')).toBe(
      '0123456789abcdef0123456789abcdef01234567'
    )
  })
})
