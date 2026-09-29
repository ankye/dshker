import { readFile } from 'node:fs/promises'
import nodePath from 'node:path'
import { ManagedHarnessRuntimeError } from './runtime-errors'

const PROFILE_NAME = 'web'

interface PackageManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly main?: unknown
  readonly peerDependencies?: unknown
  readonly dependencies?: unknown
  readonly dsh?: unknown
}

interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly (number | string)[]
}

/**
 * Refuses to launch a core with profile plugins whose declared DSH peer range
 * excludes that core. The profile remains the installation authority;
 * this function only reads its package records and never rewrites them.
 */
export async function assertProfileCompatibility(
  versionDirectory: string,
  dshHomeDirectory: string
): Promise<void> {
  const rootManifest = await readManifest(
    nodePath.join(versionDirectory, 'package.json'),
    'The selected DSH version is missing its package manifest.'
  )
  const coreVersion = requiredString(
    rootManifest.version,
    'The selected DSH core package has no valid version.'
  )
  const settingsManifest = await readManifest(
    nodePath.join(versionDirectory, 'packages', 'settings', 'settings', 'package.json'),
    'The selected DSH version is missing its settings package manifest.'
  )
  const settingsVersion = requiredString(
    settingsManifest.version,
    'The selected DSH settings package has no valid version.'
  )
  const profilePath = nodePath.join(dshHomeDirectory, 'profiles', PROFILE_NAME, 'package.json')
  const profile = await readManifest(profilePath, 'The native DSH web profile is invalid.')
  const dependencies = recordOfStrings(
    profile.dependencies,
    'The native DSH web profile dependencies are invalid.'
  )
  const bundles = readBundles(profile.dsh)
  const userPlugins = bundles.filter((name) => dependencies[name] !== undefined)
  const incompatible: string[] = []
  for (const name of userPlugins) {
    const dependency = dependencies[name]
    if (dependency === undefined) continue
    const pluginDirectory = resolveDependencyDirectory(profilePath, name, dependency)
    const pluginManifest = await readManifest(
      nodePath.join(pluginDirectory, 'package.json'),
      `The installed DSH plugin ${name} is missing its package manifest.`
    )
    const peerDependencies = recordOfStrings(
      pluginManifest.peerDependencies,
      `The installed DSH plugin ${name} has invalid peer dependencies.`
    )
    const incompatiblePeers = Object.entries(peerDependencies).filter(
      ([peerName, range]) =>
        peerName.startsWith('@deepseek-ai/dsh-') && !satisfiesVersion(coreVersion, range)
    )
    if (incompatiblePeers.length === 0) continue
    incompatible.push(
      `${name} (requires ${incompatiblePeers.map(([peerName, range]) => `${peerName} ${range}`).join(', ')})`
    )
  }
  if (incompatible.length === 0) return
  throw new ManagedHarnessRuntimeError(
    'runtime.plugin_incompatible',
    `The selected DSH core ${settingsVersion} is incompatible with installed profile plugin(s): ${incompatible.join(', ')}. Update those plugins or switch to a DSH core in their supported range before starting Web.`,
    { coreVersion: settingsVersion, plugins: incompatible.join(', ') }
  )
}

function readBundles(value: unknown): readonly string[] {
  if (value === undefined) return []
  if (!isRecord(value) || !isRecord(value.profile)) {
    throw new ManagedHarnessRuntimeError(
      'runtime.plugin_incompatible',
      'The native DSH web profile bundle record is invalid.'
    )
  }
  const bundles = value.profile.bundles
  if (bundles === undefined) return []
  if (!Array.isArray(bundles) || bundles.some((entry) => typeof entry !== 'string')) {
    throw new ManagedHarnessRuntimeError(
      'runtime.plugin_incompatible',
      'The native DSH web profile bundle record is invalid.'
    )
  }
  return bundles
}

function resolveDependencyDirectory(profilePath: string, name: string, dependency: string): string {
  if (dependency.startsWith('file:')) {
    const value = dependency.slice('file:'.length)
    if (value.length === 0) {
      throw new ManagedHarnessRuntimeError(
        'runtime.plugin_incompatible',
        'The native DSH web profile contains an empty local plugin dependency.'
      )
    }
    return nodePath.resolve(nodePath.dirname(profilePath), value)
  }
  return nodePath.join(nodePath.dirname(profilePath), 'node_modules', name)
}

async function readManifest(path: string, message: string): Promise<PackageManifest> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) {
      throw new ManagedHarnessRuntimeError('runtime.worktree_invalid', message)
    }
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new ManagedHarnessRuntimeError('runtime.worktree_invalid', message)
  }
  if (!isRecord(value)) {
    throw new ManagedHarnessRuntimeError('runtime.worktree_invalid', message)
  }
  return value
}

function recordOfStrings(value: unknown, message: string): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    throw new ManagedHarnessRuntimeError('runtime.plugin_incompatible', message)
  }
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' || key.length === 0) {
      throw new ManagedHarnessRuntimeError('runtime.plugin_incompatible', message)
    }
    result[key] = entry
  }
  return result
}

function requiredString(value: unknown, message: string): string {
  if (typeof value === 'string' && parseVersion(value) !== undefined) return value
  throw new ManagedHarnessRuntimeError('runtime.worktree_invalid', message)
}

/** Supports the comparator ranges emitted by the DSH plugin manifests. */
export function satisfiesVersion(versionText: string, rangeText: string): boolean {
  const version = parseVersion(versionText)
  if (version === undefined) return false
  const range = rangeText.trim()
  if (range === '' || range === '*' || range === 'workspace:*') return true
  return range.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/u).filter(Boolean)
    if (comparators.length === 0) return true
    return comparators.every((comparator) => satisfiesComparator(version, comparator))
  })
}

function satisfiesComparator(version: ParsedVersion, comparator: string): boolean {
  const match = /^(>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(comparator)
  if (match === null) {
    // A wildcard peer range does not constrain this package. Other range
    // syntax is deliberately rejected instead of being guessed.
    if (/^(?:\^|~)?\d+(?:\.\d+)?(?:\.x)?$/u.test(comparator)) {
      throw new ManagedHarnessRuntimeError(
        'runtime.plugin_incompatible',
        `The installed DSH plugin declares an unsupported DSH version range: ${comparator}.`
      )
    }
    return comparator === '*' || comparator === 'workspace:*'
  }
  const expected = parseVersion(match[2])
  if (expected === undefined) return false
  const comparison = compareVersions(version, expected)
  switch (match[1] ?? '=') {
    case '>=':
      return comparison >= 0
    case '>':
      return comparison > 0
    case '<=':
      return comparison <= 0
    case '<':
      return comparison < 0
    default:
      return comparison === 0
  }
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value)
  if (match === null) return undefined
  const prerelease = match[4] === undefined ? [] : match[4].split('.').map(parsePrerelease)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease
  }
}

function parsePrerelease(value: string): number | string {
  return /^\d+$/u.test(value) ? Number(value) : value
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    if (typeof leftPart === 'number' && typeof rightPart === 'string') return -1
    if (typeof leftPart === 'string' && typeof rightPart === 'number') return 1
    return leftPart > rightPart ? 1 : -1
  }
  return 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
