import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const REQUIRED_NODE_HEADERS = ['node_api.h', 'node.h', 'node_version.h']

/** Hashes a real directory tree using sorted, normalized relative paths. */
export function sha256RuntimeDirectory(directoryPath) {
  const metadata = lstatSync(directoryPath)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Runtime directory is not a real directory: ${directoryPath}`)
  }

  const hash = createHash('sha256')
  function visit(currentPath, relativeDirectory) {
    const entries = readdirSync(currentPath, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    )
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name)
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        throw new Error(`Runtime directory cannot contain symbolic links: ${relativePath}`)
      }
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`)
        visit(entryPath, relativePath)
      } else if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0`)
        hash.update(readFileSync(entryPath))
      } else {
        throw new Error(`Runtime directory contains an unsupported entry: ${relativePath}`)
      }
    }
  }

  visit(directoryPath, '')
  return hash.digest('hex')
}

/** Requires the Node-API headers DSH's native build consumes, then hashes them. */
export function sha256NodeHeaders(directoryPath) {
  for (const filename of REQUIRED_NODE_HEADERS) {
    const headerPath = path.join(directoryPath, filename)
    const metadata = lstatSync(headerPath)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Required Node header is not a regular file: ${filename}`)
    }
  }
  return sha256RuntimeDirectory(directoryPath)
}
