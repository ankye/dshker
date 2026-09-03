import { createWriteStream } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import nodePath from 'node:path'
import { pipeline } from 'node:stream/promises'
import { openPromise, validateFileName, type Entry } from 'yauzl'
import { ManagedHarnessRuntimeError } from './runtime-errors'

/** Archive limits are fixed security invariants for one user-selected plugin package. */
const MAX_ENTRY_COUNT = 10_000
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
const UNIX_FILE_TYPE_MASK = 0o170000
const UNIX_SYMBOLIC_LINK = 0o120000

/** Extracts one user-selected ZIP into an owned directory and returns its plugin package root. */
export async function extractPluginArchive(
  archivePath: string,
  destination: string
): Promise<string> {
  await assertZipFile(archivePath)
  await mkdir(destination, { recursive: false })
  const zip = await openPromise(archivePath, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true
  })
  try {
    if (zip.entryCount > MAX_ENTRY_COUNT)
      throw invalidArchive('Plugin archive has too many entries.')
    let totalUncompressedBytes = 0
    const entries = new Set<string>()
    for await (const entry of zip.eachEntry()) {
      const target = archiveTarget(destination, entry)
      if (entries.has(target)) throw invalidArchive('Plugin archive contains a duplicate entry.')
      entries.add(target)
      if (entry.fileName.endsWith('/')) {
        await mkdir(target, { recursive: true })
        continue
      }
      totalUncompressedBytes += entry.uncompressedSize
      if (totalUncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
        throw invalidArchive('Plugin archive exceeds the supported extracted size.')
      }
      await mkdir(nodePath.dirname(target), { recursive: true })
      await pipeline(
        await zip.openReadStreamPromise(entry),
        createWriteStream(target, { flags: 'wx' })
      )
    }
  } finally {
    zip.close()
  }
  return resolvePluginPackageRoot(destination)
}

async function assertZipFile(archivePath: string): Promise<void> {
  if (nodePath.extname(archivePath).toLowerCase() !== '.zip') {
    throw invalidArchive('Plugin source must be a ZIP archive.')
  }
  let metadata
  try {
    metadata = await stat(archivePath)
  } catch {
    throw invalidArchive('Plugin archive is unavailable.')
  }
  if (!metadata.isFile()) throw invalidArchive('Plugin source must be a regular ZIP file.')
}

function archiveTarget(destination: string, entry: Entry): string {
  if (validateFileName(entry.fileName) !== null) {
    throw invalidArchive('Plugin archive contains an unsafe entry path.')
  }
  const unixFileType = (entry.externalFileAttributes >>> 16) & UNIX_FILE_TYPE_MASK
  if (unixFileType === UNIX_SYMBOLIC_LINK) {
    throw invalidArchive('Plugin archive cannot contain symbolic links.')
  }
  const target = nodePath.resolve(destination, ...entry.fileName.split('/'))
  const relative = nodePath.relative(destination, target)
  if (relative.length === 0 || relative === '..' || relative.startsWith(`..${nodePath.sep}`)) {
    throw invalidArchive('Plugin archive contains an unsafe entry path.')
  }
  return target
}

async function resolvePluginPackageRoot(destination: string): Promise<string> {
  if (await hasPackageManifest(destination)) return destination
  const entries = await readdir(destination, { withFileTypes: true })
  if (entries.length !== 1 || !entries[0]?.isDirectory()) {
    throw invalidArchive('Plugin archive must contain one package root with package.json.')
  }
  const packageRoot = nodePath.join(destination, entries[0].name)
  if (!(await hasPackageManifest(packageRoot))) {
    throw invalidArchive('Plugin archive package root is missing package.json.')
  }
  return packageRoot
}

async function hasPackageManifest(directory: string): Promise<boolean> {
  try {
    return (await stat(nodePath.join(directory, 'package.json'))).isFile()
  } catch {
    return false
  }
}

function invalidArchive(message: string): ManagedHarnessRuntimeError {
  return new ManagedHarnessRuntimeError('runtime.plugin_operation_failed', message)
}
