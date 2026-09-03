import type { LauncherHarnessPluginView } from '../../../src/shared/contracts'

/** Derives the plugin-layer view from one parsed native DSH web-profile manifest. */
export function parseProfilePluginRecords(value: unknown): readonly LauncherHarnessPluginView[] {
  if (!isRecord(value)) throw new Error('The native DSH web profile package record is invalid.')
  const dependencies = value.dependencies ?? {}
  if (!isRecord(dependencies)) {
    throw new Error('The native DSH web profile package record is invalid.')
  }
  const bundles = readProfileBundles(value.dsh)
  const views = new Map<string, LauncherHarnessPluginView>()
  for (const [name, version] of Object.entries(dependencies)) {
    if (typeof version !== 'string') {
      throw new Error('The native DSH web profile package record is invalid.')
    }
    views.set(name, { name, version, origin: 'user' })
  }
  for (const name of bundles) {
    if (views.has(name)) continue
    views.set(name, { name, version: '', origin: 'default' })
  }
  return [...views.values()].sort(
    (left, right) =>
      Number(left.origin === 'default') - Number(right.origin === 'default') ||
      left.name.localeCompare(right.name)
  )
}

/** Reads the local checkout path of a `file:` dependency specifier. */
export function localPathOf(version: string): string | undefined {
  if (!version.startsWith('file:')) return undefined
  const value = version.slice('file:'.length)
  return value.length === 0 ? undefined : value
}

/** Reads a git specifier that already names a remote directly. */
export function gitUrlOf(version: string): string | undefined {
  if (/^(?:git\+)?(?:https?|ssh):\/\//u.test(version) || version.startsWith('git@')) {
    return normalizeGitRemote(version)
  }
  return undefined
}

/** Normalizes equivalent SSH and HTTPS remotes for catalog matching. */
export function normalizeGitRemote(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/^git\+/u, '')
  if (trimmed.length === 0) return undefined
  const sshMatch = /^(?:ssh:\/\/)?git@([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?$/u.exec(trimmed)
  if (sshMatch !== null) return `https://${sshMatch[1]}/${sshMatch[2]}`
  const httpMatch = /^(https?:\/\/[^/]+\/.+?)(?:\.git)?$/u.exec(trimmed)
  if (httpMatch !== null) return httpMatch[1].replace(/^http:/u, 'https:')
  return undefined
}

function readProfileBundles(value: unknown): readonly string[] {
  if (value === undefined) return []
  if (!isRecord(value) || !isRecord(value.profile)) {
    throw new Error('The native DSH web profile package record is invalid.')
  }
  const bundles = value.profile.bundles
  if (bundles === undefined) return []
  if (!Array.isArray(bundles) || bundles.some((entry) => typeof entry !== 'string')) {
    throw new Error('The native DSH web profile package record is invalid.')
  }
  return bundles
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
