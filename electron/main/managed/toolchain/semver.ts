import { ToolchainRuntimeError } from './errors'
import type {
  NodeVersionComparator,
  NodeVersionRange,
  PnpmPackageManagerDeclaration,
  ToolchainVersion
} from './types'

const VERSION_COMPONENT = '(?:0|[1-9][0-9]*)'
const FULL_VERSION = new RegExp(
  `^(?<major>${VERSION_COMPONENT})\\.(?<minor>${VERSION_COMPONENT})\\.(?<patch>${VERSION_COMPONENT})$`
)
const PARTIAL_VERSION = new RegExp(
  `^(?<major>${VERSION_COMPONENT})(?:\\.(?<minor>${VERSION_COMPONENT}))?(?:\\.(?<patch>${VERSION_COMPONENT}))?$`
)
const COMPARATOR = new RegExp(
  `^(?<operator>\\^|~|>=|<=|>|<|=)?(?<version>${VERSION_COMPONENT}(?:\\.${VERSION_COMPONENT}){0,2})$`
)

/** Parses an exact, stable three-component semantic version. */
export function parseToolchainVersion(value: string): ToolchainVersion {
  const match = FULL_VERSION.exec(value)
  if (!match?.groups) {
    throw new ToolchainRuntimeError('toolchain.version_invalid', 'Tool version is invalid.')
  }
  return createVersion(
    match.groups.major,
    match.groups.minor,
    match.groups.patch,
    'toolchain.version_invalid'
  )
}

/** Parses the complete version line emitted by a direct Node executable. */
export function parseNodeVersionOutput(value: string): ToolchainVersion {
  const match = /^v(?<version>[^\r\n]+)\r?\n?$/.exec(value)
  if (!match?.groups) {
    throw new ToolchainRuntimeError('toolchain.version_invalid', 'Node version output is invalid.')
  }
  return parseToolchainVersion(match.groups.version)
}

/** Parses the complete version line emitted by a direct pnpm entry. */
export function parsePnpmVersionOutput(value: string): ToolchainVersion {
  if (!/^[^\r\n]+\r?\n?$/.test(value)) {
    throw new ToolchainRuntimeError('toolchain.version_invalid', 'pnpm version output is invalid.')
  }
  return parseToolchainVersion(value.replace(/\r?\n$/, ''))
}

/** Parses the strict `pnpm@x.y.z` identity required by the selected checkout. */
export function parsePnpmPackageManagerDeclaration(value: string): PnpmPackageManagerDeclaration {
  const match = /^pnpm@(?<version>[^\s@]+)$/.exec(value)
  if (!match?.groups) {
    throw new ToolchainRuntimeError(
      'toolchain.package_manager_invalid',
      'packageManager must declare an exact pnpm version.'
    )
  }
  let version: ToolchainVersion
  try {
    version = parseToolchainVersion(match.groups.version)
  } catch (error) {
    if (error instanceof ToolchainRuntimeError) {
      throw new ToolchainRuntimeError(
        'toolchain.package_manager_invalid',
        'packageManager must declare an exact pnpm version.'
      )
    }
    throw error
  }
  return { text: `pnpm@${version.text}`, version }
}

/** Parses the supported explicit subset of the checkout's `engines.node` range. */
export function parseNodeVersionRange(value: string): NodeVersionRange {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 512) {
    throw new ToolchainRuntimeError(
      'toolchain.node_requirement_invalid',
      'engines.node is invalid.'
    )
  }

  const alternatives = value.split('||').map((alternative) => {
    const trimmed = alternative.trim()
    if (!trimmed) {
      throw new ToolchainRuntimeError(
        'toolchain.node_requirement_invalid',
        'engines.node contains an empty alternative.'
      )
    }
    const comparators = trimmed.split(/\s+/).map(parseNodeComparator)
    if (comparators.length > 16) {
      throw new ToolchainRuntimeError(
        'toolchain.node_requirement_invalid',
        'engines.node contains too many comparators.'
      )
    }
    return comparators
  })

  if (alternatives.length > 16) {
    throw new ToolchainRuntimeError(
      'toolchain.node_requirement_invalid',
      'engines.node contains too many alternatives.'
    )
  }
  return { text: value, alternatives }
}

/** Returns whether one exact Node release satisfies an explicit `engines.node` range. */
export function nodeVersionSatisfiesRange(
  version: ToolchainVersion,
  range: NodeVersionRange
): boolean {
  return range.alternatives.some((alternative) =>
    alternative.every((comparator) => nodeVersionSatisfiesComparator(version, comparator))
  )
}

/** Compares two stable semantic versions without coercing partial versions. */
export function compareToolchainVersions(left: ToolchainVersion, right: ToolchainVersion): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return 0
}

function parseNodeComparator(value: string): NodeVersionComparator {
  const match = COMPARATOR.exec(value)
  if (!match?.groups) {
    throw new ToolchainRuntimeError(
      'toolchain.node_requirement_invalid',
      'engines.node contains an unsupported comparator.'
    )
  }

  const operator = (match.groups.operator || '=') as NodeVersionComparator['operator']
  const parsed = parsePartialVersion(match.groups.version)
  if (
    (operator === '>' || operator === '>=' || operator === '<' || operator === '<=') &&
    parsed.precision !== 3
  ) {
    throw new ToolchainRuntimeError(
      'toolchain.node_requirement_invalid',
      'Inequality comparators in engines.node require three version components.'
    )
  }
  return { operator, ...parsed }
}

function parsePartialVersion(value: string): Pick<NodeVersionComparator, 'version' | 'precision'> {
  const match = PARTIAL_VERSION.exec(value)
  if (!match?.groups) {
    throw new ToolchainRuntimeError(
      'toolchain.node_requirement_invalid',
      'engines.node contains an invalid version.'
    )
  }
  const precision = match.groups.patch ? 3 : match.groups.minor ? 2 : 1
  return {
    version: createVersion(
      match.groups.major,
      match.groups.minor ?? '0',
      match.groups.patch ?? '0',
      'toolchain.node_requirement_invalid'
    ),
    precision
  }
}

function nodeVersionSatisfiesComparator(
  version: ToolchainVersion,
  comparator: NodeVersionComparator
): boolean {
  const comparison = compareToolchainVersions(version, comparator.version)
  switch (comparator.operator) {
    case '>':
      return comparison > 0
    case '>=':
      return comparison >= 0
    case '<':
      return comparison < 0
    case '<=':
      return comparison <= 0
    case '=':
      if (comparator.precision === 3) return comparison === 0
      return (
        comparison >= 0 && compareToolchainVersions(version, nextPartialVersion(comparator)) < 0
      )
    case '^':
      return comparison >= 0 && compareToolchainVersions(version, caretUpperBound(comparator)) < 0
    case '~':
      return comparison >= 0 && compareToolchainVersions(version, tildeUpperBound(comparator)) < 0
  }
}

function nextPartialVersion(comparator: NodeVersionComparator): ToolchainVersion {
  if (comparator.precision === 1) return versionAt(comparator.version.major + 1, 0, 0)
  if (comparator.precision === 2)
    return versionAt(comparator.version.major, comparator.version.minor + 1, 0)
  return comparator.version
}

function caretUpperBound(comparator: NodeVersionComparator): ToolchainVersion {
  if (comparator.precision === 1 || comparator.version.major > 0) {
    return versionAt(comparator.version.major + 1, 0, 0)
  }
  if (comparator.precision === 2 || comparator.version.minor > 0) {
    return versionAt(comparator.version.major, comparator.version.minor + 1, 0)
  }
  return versionAt(comparator.version.major, comparator.version.minor, comparator.version.patch + 1)
}

function tildeUpperBound(comparator: NodeVersionComparator): ToolchainVersion {
  if (comparator.precision === 1) return versionAt(comparator.version.major + 1, 0, 0)
  return versionAt(comparator.version.major, comparator.version.minor + 1, 0)
}

function createVersion(
  majorSource: string,
  minorSource: string,
  patchSource: string,
  code: 'toolchain.version_invalid' | 'toolchain.node_requirement_invalid'
): ToolchainVersion {
  const major = Number(majorSource)
  const minor = Number(minorSource)
  const patch = Number(patchSource)
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new ToolchainRuntimeError(code, 'Tool version contains an unsafe component.')
  }
  return { major, minor, patch, text: `${major}.${minor}.${patch}` }
}

function versionAt(major: number, minor: number, patch: number): ToolchainVersion {
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new ToolchainRuntimeError(
      'toolchain.node_requirement_invalid',
      'engines.node exceeds safe bounds.'
    )
  }
  return { major, minor, patch, text: `${major}.${minor}.${patch}` }
}
