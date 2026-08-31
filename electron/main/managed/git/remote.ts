import { GitRuntimeError } from './errors'
import type { GitNamedRemote, GitRemoteIdentity, GitRemoteSource } from './types'

const REMOTE_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const SSH_USER = /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const REPOSITORY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Parses one production remote URL without treating local paths or helpers as Git remotes. */
export function parseGitRemoteSource(value: unknown): GitRemoteSource {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new GitRuntimeError('git.remote_invalid', 'Git remote URL is required.')
  }
  if (/\s|[\u0000-\u001f\\]|[%#?]/.test(value)) {
    throw new GitRuntimeError(
      'git.remote_invalid',
      'Git remote URL contains unsupported characters.'
    )
  }
  if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(value)) {
    throw new GitRuntimeError(
      'git.remote_invalid',
      'Git remote URL contains an ambiguous path segment.'
    )
  }

  const scp = parseScpSyntax(value)
  if (scp) return { declaredUrl: value, identity: scp }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new GitRuntimeError('git.remote_invalid', 'Git remote URL must use HTTPS or SSH.')
  }

  if (parsed.protocol === 'https:') {
    return { declaredUrl: value, identity: parseHttps(parsed) }
  }
  if (parsed.protocol === 'ssh:') {
    return { declaredUrl: value, identity: parseSshUrl(parsed) }
  }
  throw new GitRuntimeError('git.remote_invalid', 'Git remote transport is not supported.')
}

/** Validates a Git remote name before it becomes an argument to any Git command. */
export function assertGitRemoteName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !REMOTE_NAME.test(value) || value.startsWith('.')) {
    throw new GitRuntimeError('git.remote_invalid', 'Git remote name is invalid.')
  }
}

/** Creates a named remote only after independently checking the name and source URL. */
export function createGitNamedRemote(name: unknown, source: unknown): GitNamedRemote {
  assertGitRemoteName(name)
  return { name, source: parseGitRemoteSource(source) }
}

/** Validates a persisted named remote before any Git command can use its values. */
export function assertGitNamedRemote(value: unknown): asserts value is GitNamedRemote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitRuntimeError('git.remote_invalid', 'Git remote record is invalid.')
  }
  const record = value as Record<string, unknown>
  if (!hasOwn(record, 'name') || !hasOwn(record, 'source')) {
    throw new GitRuntimeError('git.remote_invalid', 'Git remote record is invalid.')
  }
  assertGitRemoteName(record.name)
  if (!record.source || typeof record.source !== 'object' || Array.isArray(record.source)) {
    throw new GitRuntimeError('git.remote_invalid', 'Git remote source is invalid.')
  }
  const source = record.source as Record<string, unknown>
  if (
    Object.keys(source).length !== 2 ||
    !hasOwn(source, 'declaredUrl') ||
    !hasOwn(source, 'identity')
  ) {
    throw new GitRuntimeError('git.remote_invalid', 'Git remote source is invalid.')
  }
  const parsed = parseGitRemoteSource(source.declaredUrl)
  if (!source.identity || typeof source.identity !== 'object' || Array.isArray(source.identity)) {
    throw new GitRuntimeError('git.remote_invalid', 'Git remote identity is invalid.')
  }
  const identity = source.identity as GitRemoteIdentity
  const expectedIdentityKeys = [
    'transport',
    'host',
    'effectivePort',
    'repositoryPathKind',
    'repositoryPath',
    'display',
    ...(parsed.identity.sshUser ? ['sshUser'] : [])
  ]
  if (
    Object.keys(identity).length !== expectedIdentityKeys.length ||
    expectedIdentityKeys.some((key) => !hasOwn(identity, key)) ||
    !gitRemoteIdentitiesEqual(parsed.identity, identity) ||
    identity.display !== parsed.identity.display
  ) {
    throw new GitRuntimeError(
      'git.remote_invalid',
      'Git remote identity does not match its declared URL.'
    )
  }
}

/** Compares transport identity rather than display text or a Git configuration rewrite. */
export function gitRemoteIdentitiesEqual(
  left: GitRemoteIdentity,
  right: GitRemoteIdentity
): boolean {
  return (
    left.transport === right.transport &&
    left.host === right.host &&
    left.effectivePort === right.effectivePort &&
    left.sshUser === right.sshUser &&
    left.repositoryPathKind === right.repositoryPathKind &&
    left.repositoryPath === right.repositoryPath
  )
}

/** Rejects an observed remote when it differs from the user-confirmed source identity. */
export function assertGitRemoteIdentity(
  expected: GitRemoteIdentity,
  observed: GitRemoteIdentity
): void {
  if (!gitRemoteIdentitiesEqual(expected, observed)) {
    throw new GitRuntimeError(
      'git.remote_mismatch',
      'Observed Git remote does not match the selected source.',
      {
        expected: expected.display,
        observed: observed.display
      }
    )
  }
}

function parseHttps(value: URL): GitRemoteIdentity {
  if (value.username || value.password || value.hash || value.search || value.port === '0') {
    throw new GitRuntimeError(
      'git.remote_invalid',
      'HTTPS Git remotes cannot carry credentials or URL extras.'
    )
  }
  const host = parseHost(value.hostname)
  const effectivePort = parsePort(value.port, 443)
  const repositoryPath = parseRepositoryPath(value.pathname, 'absolute')
  return {
    transport: 'https',
    host,
    effectivePort,
    repositoryPathKind: 'absolute',
    repositoryPath,
    display: `https://${host}:${effectivePort}/${repositoryPath}`
  }
}

function parseSshUrl(value: URL): GitRemoteIdentity {
  if (value.password || value.hash || value.search || value.port === '0') {
    throw new GitRuntimeError(
      'git.remote_invalid',
      'SSH Git remote URL contains unsupported credentials or URL extras.'
    )
  }
  if (value.username && !SSH_USER.test(value.username)) {
    throw new GitRuntimeError('git.remote_invalid', 'SSH Git remote user is invalid.')
  }
  const host = parseHost(value.hostname)
  const effectivePort = parsePort(value.port, 22)
  const repositoryPath = parseRepositoryPath(value.pathname, 'absolute')
  return {
    transport: 'ssh',
    host,
    effectivePort,
    ...(value.username ? { sshUser: value.username } : {}),
    repositoryPathKind: 'absolute',
    repositoryPath,
    display: `ssh://${value.username ? `${value.username}@` : ''}${host}:${effectivePort}/${repositoryPath}`
  }
}

function parseScpSyntax(value: string): GitRemoteIdentity | undefined {
  if (value.includes('://')) return undefined
  const match = /^(?:(?<user>[A-Za-z_][A-Za-z0-9._-]{0,63})@)?(?<host>[^:@/]+):(?<path>.+)$/.exec(
    value
  )
  if (!match?.groups) return undefined
  const user = match.groups.user
  const host = parseHost(match.groups.host)
  const repositoryPathKind = match.groups.path.startsWith('/') ? 'absolute' : 'relative'
  const repositoryPath = parseRepositoryPath(match.groups.path, repositoryPathKind)
  return {
    transport: 'ssh',
    host,
    effectivePort: 22,
    ...(user ? { sshUser: user } : {}),
    repositoryPathKind,
    repositoryPath,
    display:
      repositoryPathKind === 'relative'
        ? `ssh-scp://${user ? `${user}@` : ''}${host}:22:${repositoryPath}`
        : `ssh://${user ? `${user}@` : ''}${host}:22/${repositoryPath}`
  }
}

function parseHost(value: string): string {
  const host = value.toLowerCase()
  if (!host || host.length > 253 || host.includes('..')) {
    throw new GitRuntimeError('git.remote_invalid', 'Git remote host is invalid.')
  }
  if (host === 'localhost' || isIpv4(host) || isBracketedIpv6(host)) return host
  if (!host.split('.').every((label) => DNS_LABEL.test(label))) {
    throw new GitRuntimeError('git.remote_invalid', 'Git remote host is invalid.')
  }
  return host
}

function parsePort(value: string, defaultPort: number): number {
  if (value === '') return defaultPort
  if (!/^[1-9][0-9]{0,4}$/.test(value)) {
    throw new GitRuntimeError('git.remote_invalid', 'Git remote port is invalid.')
  }
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new GitRuntimeError('git.remote_invalid', 'Git remote port is invalid.')
  }
  return port
}

function parseRepositoryPath(value: string, kind: 'absolute' | 'relative'): string {
  const path = kind === 'absolute' ? value.slice(1) : value
  if (!path || path.length > 1024 || path.startsWith('/') || path.endsWith('/')) {
    throw new GitRuntimeError('git.remote_invalid', 'Git remote repository path is invalid.')
  }
  const segments = path.split('/')
  if (
    segments.some(
      (segment) => !REPOSITORY_SEGMENT.test(segment) || segment === '.' || segment === '..'
    )
  ) {
    throw new GitRuntimeError('git.remote_invalid', 'Git remote repository path is invalid.')
  }
  return path
}

function isIpv4(value: string): boolean {
  const parts = value.split('.')
  return (
    parts.length === 4 &&
    parts.every(
      (part) =>
        /^[0-9]{1,3}$/.test(part) &&
        (part === '0' || !part.startsWith('0')) &&
        Number(part) >= 0 &&
        Number(part) <= 255
    )
  )
}

function isBracketedIpv6(value: string): boolean {
  return /^\[[0-9a-f:]+\]$/i.test(value)
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}
