import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/** A direct executable invocation suitable for Node's shell-free spawn. */
export interface PnpmLauncher {
  readonly resolutionError?: string
  readonly executable: string
  readonly prefixArguments: readonly string[]
  /** PATH supplied to pnpm, whose entry scripts resolve bundled Node first. */
  readonly commandSearchPath: string
}

const NODE_VERSION = '22.23.3'

/**
 * Resolve only the required, staged standalone Node/pnpm pair. Missing runtime
 * data is a launch refusal; Electron and system Node/pnpm are not substitutes.
 */
export function resolvePnpmLauncher(bundledRuntimeRoot?: string): PnpmLauncher {
  const pnpmEntry = bundledPnpmEntry(bundledRuntimeRoot)
  if (bundledRuntimeRoot === undefined || pnpmEntry === undefined) {
    const root = bundledRuntimeRoot ?? '(runtime root not configured)'
    return {
      executable: '',
      prefixArguments: [],
      commandSearchPath: '',
      resolutionError: `The bundled Node/pnpm runtime is unavailable or invalid at ${root}. Run runtime:prepare for ${process.platform}-${process.arch} and restart Launcher.`
    }
  }
  const bin = path.join(bundledRuntimeRoot, 'bin')
  return {
    executable: nodeExecutablePath(bundledRuntimeRoot),
    prefixArguments: ['--expose-internals', pnpmEntry],
    commandSearchPath: [bin, ...splitPath(process.env.PATH)].join(path.delimiter)
  }
}

/** The staged pnpm entry, or undefined when its required runtime is incomplete. */
export function bundledPnpmEntry(bundledRuntimeRoot: string | undefined): string | undefined {
  if (bundledRuntimeRoot === undefined || bundledRuntimeRoot.length === 0) return undefined
  const pnpmEntry = path.join(bundledRuntimeRoot, 'pnpm', 'bin', 'pnpm.mjs')
  const executable = nodeExecutablePath(bundledRuntimeRoot)
  const descriptorPath = path.join(bundledRuntimeRoot, 'versions.json')
  if (
    !isRegularFile(pnpmEntry) ||
    !isRegularFile(executable) ||
    !isRegularFile(path.join(bundledRuntimeRoot, 'LICENSE.node')) ||
    !isRegularFile(descriptorPath)
  ) {
    return undefined
  }
  try {
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'))
    const archiveExtension = process.platform === 'win32' ? 'zip' : 'tar.gz'
    const archivePlatform = process.platform === 'win32' ? 'win' : process.platform
    const expectedArchive = `node-v${NODE_VERSION}-${archivePlatform}-${process.arch}.${archiveExtension}`
    if (
      descriptor?.schemaVersion !== 2 ||
      descriptor.platform !== process.platform ||
      descriptor.arch !== process.arch ||
      descriptor.node !== NODE_VERSION ||
      descriptor.nodeArchive !== expectedArchive ||
      !isDigest(descriptor.nodeArchiveSha256) ||
      !isDigest(descriptor.nodeBinarySha256) ||
      typeof descriptor.pnpm !== 'string' ||
      descriptor.pnpm.length === 0
    ) {
      return undefined
    }
  } catch {
    return undefined
  }
  return pnpmEntry
}

function nodeExecutablePath(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
}

function splitPath(pathValue: string | undefined): readonly string[] {
  return (pathValue ?? '').split(path.delimiter).filter((entry) => entry.length > 0)
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}
