import { createHash } from 'node:crypto'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Recomputes the peer helper manifest digest after code signing.
 *
 * The manifest is written when the Go helper is built, but electron-builder then
 * code-signs every executable inside the package. Signing rewrites the binary, so
 * the recorded digest no longer described the file that shipped. The launcher
 * verifies that digest before it will start the helper, so it refused with
 * p2p.helper_integrity_failed: the app opened normally, the helper never ran, and
 * every P2P feature was silently dead in every packaged build.
 *
 * The check itself is worth keeping, so the manifest is corrected here rather than
 * excluding the helper from signing. Running after signing means the digest
 * describes the exact bytes the runtime will read.
 */
export default async function afterSign(context) {
  const resources = resourcesPath(context)
  const root = join(resources, 'p2p')

  let targets
  try {
    targets = await readdir(root, { withFileTypes: true })
  } catch {
    // A package built without the helper has nothing to correct; the packaging
    // contract test is what guarantees the helper is present.
    return
  }

  for (const entry of targets) {
    if (!entry.isDirectory()) continue
    const directory = join(root, entry.name)

    let files
    try {
      files = await readdir(directory, { withFileTypes: true })
    } catch {
      throw new Error(`peer helper directory unreadable for ${entry.name}`)
    }
    // Every manifest in the target directory is resealed: the frozen peer
    // helper's manifest.json and the core's dshkerd-manifest.json both describe
    // code-signed executables whose digest signing invalidates.
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue
      const manifestPath = join(directory, file.name)

      let manifest
      try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      } catch {
        throw new Error(`peer helper manifest unreadable for ${entry.name}`)
      }
      if (manifest.version !== 1 || typeof manifest.file !== 'string') {
        throw new Error(`peer helper manifest unsupported for ${entry.name}`)
      }
      if (manifest.target !== entry.name) {
        throw new Error(`peer helper manifest target ${manifest.target} is not ${entry.name}`)
      }

      const binary = await readFile(join(directory, manifest.file))
      const sha256 = createHash('sha256').update(binary).digest('hex')
      if (sha256 === manifest.sha256) continue

      await writeFile(manifestPath, `${JSON.stringify({ ...manifest, sha256 })}\n`)
      console.log(`  • peer helper manifest resealed  target=${entry.name} file=${file.name}`)
    }
  }
}

/** Resolves the packaged resources directory for the platform being built. */
function resourcesPath(context) {
  const output = context.appOutDir
  if (context.electronPlatformName === 'darwin') {
    const name = `${context.packager.appInfo.productFilename}.app`
    return join(output, name, 'Contents', 'Resources')
  }
  return join(output, 'resources')
}
