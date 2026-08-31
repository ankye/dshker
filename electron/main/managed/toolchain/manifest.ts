import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import nodePath from 'node:path'
import { ToolchainRuntimeError, toolchainRuntimeFailure } from './errors'
import { parseNodeVersionRange, parsePnpmPackageManagerDeclaration } from './semver'
import type { CheckoutToolchainRequirements } from './types'

const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024

/** Reads the exact Node and pnpm declarations from a selected canonical worktree. */
export async function readCheckoutToolchainRequirements(
  worktreePath: string
): Promise<CheckoutToolchainRequirements> {
  assertCanonicalAbsolutePath(worktreePath, 'Selected worktree')
  await assertCanonicalDirectory(worktreePath, 'Selected worktree')

  const packageManifestPath = nodePath.join(worktreePath, 'package.json')
  const source = await readRegularManifest(packageManifestPath)
  const manifest = parseManifest(source)
  const engines = manifest.engines
  if (!isPlainRecord(engines) || !hasOwn(engines, 'node')) {
    throw new ToolchainRuntimeError(
      'toolchain.node_requirement_missing',
      'Selected checkout package.json does not declare engines.node.'
    )
  }
  if (typeof engines.node !== 'string') {
    throw new ToolchainRuntimeError(
      'toolchain.node_requirement_invalid',
      'Selected checkout engines.node must be a string.'
    )
  }
  if (!hasOwn(manifest, 'packageManager')) {
    throw new ToolchainRuntimeError(
      'toolchain.package_manager_missing',
      'Selected checkout package.json does not declare packageManager.'
    )
  }
  if (typeof manifest.packageManager !== 'string') {
    throw new ToolchainRuntimeError(
      'toolchain.package_manager_invalid',
      'Selected checkout packageManager must be a string.'
    )
  }

  return {
    worktreePath,
    packageManifestPath,
    nodeRange: parseNodeVersionRange(engines.node),
    pnpm: parsePnpmPackageManagerDeclaration(manifest.packageManager)
  }
}

async function assertCanonicalDirectory(path: string, subject: string): Promise<void> {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ToolchainRuntimeError(
        'toolchain.package_manifest_invalid',
        `${subject} must be a canonical directory.`
      )
    }
    const canonicalPath = await realpath(path)
    if (canonicalPath !== path) {
      throw new ToolchainRuntimeError(
        'toolchain.package_manifest_invalid',
        `${subject} changed while being preflighted.`
      )
    }
  } catch (error) {
    if (error instanceof ToolchainRuntimeError) throw error
    throw toolchainRuntimeFailure(
      'toolchain.package_manifest_missing',
      `${subject} is unavailable.`,
      error
    )
  }
}

async function readRegularManifest(path: string): Promise<string> {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new ToolchainRuntimeError(
        'toolchain.package_manifest_invalid',
        'Selected checkout package.json must be a regular file.'
      )
    }
    if (metadata.size > MAX_PACKAGE_MANIFEST_BYTES) {
      throw new ToolchainRuntimeError(
        'toolchain.package_manifest_invalid',
        'Selected checkout package.json exceeds the supported size.'
      )
    }
    const canonicalPath = await realpath(path)
    if (canonicalPath !== path) {
      throw new ToolchainRuntimeError(
        'toolchain.package_manifest_invalid',
        'Selected checkout package.json changed while being preflighted.'
      )
    }
    const contents = await readFile(path, 'utf8')
    const verifiedMetadata = await stat(path)
    if (
      verifiedMetadata.dev !== metadata.dev ||
      verifiedMetadata.ino !== metadata.ino ||
      verifiedMetadata.size !== metadata.size ||
      verifiedMetadata.mtimeMs !== metadata.mtimeMs
    ) {
      throw new ToolchainRuntimeError(
        'toolchain.package_manifest_invalid',
        'Selected checkout package.json changed while being read.'
      )
    }
    return contents
  } catch (error) {
    if (error instanceof ToolchainRuntimeError) throw error
    throw toolchainRuntimeFailure(
      'toolchain.package_manifest_missing',
      'Selected checkout package.json is unavailable.',
      error
    )
  }
}

function parseManifest(source: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw toolchainRuntimeFailure(
      'toolchain.package_manifest_invalid',
      'Selected checkout package.json is not valid JSON.',
      error
    )
  }
  if (!isPlainRecord(parsed)) {
    throw new ToolchainRuntimeError(
      'toolchain.package_manifest_invalid',
      'Selected checkout package.json must contain an object.'
    )
  }
  return parsed
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function assertCanonicalAbsolutePath(value: unknown, subject: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\u0000') ||
    !nodePath.isAbsolute(value) ||
    nodePath.normalize(value) !== value ||
    nodePath.parse(value).root === value
  ) {
    throw new ToolchainRuntimeError(
      'toolchain.package_manifest_invalid',
      `${subject} must be an absolute, normalized, non-root path.`
    )
  }
}
