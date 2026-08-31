#!/usr/bin/env node
import {
  BundledSeedError,
  bundledSeedStagingDirectory,
  verifyBundledSeedDirectory
} from './bundled-seed.mjs'

function usage() {
  console.log(`Verify the generated DSH bundled-seed manifest and every packaged resource.

Usage:
  node tools/verify-bundled-seed.mjs [--directory <absolute-path>] [--json]
`)
}

function parseArgs(argv) {
  const result = { directory: bundledSeedStagingDirectory, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') result.help = true
    else if (argument === '--json') result.json = true
    else if (argument === '--directory') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('Missing value for --directory')
      result.directory = value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }
  const result = await verifyBundledSeedDirectory(args.directory)
  const payload = {
    ok: true,
    directory: result.directory,
    revision: result.manifest.harness.revision,
    remoteUrl: result.manifest.remoteUrl,
    pluginGenerationId: result.manifest.pluginGeneration.generationId
  }
  console.log(
    args.json ? JSON.stringify(payload, null, 2) : `Bundled seed verified for ${payload.revision}.`
  )
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof BundledSeedError ? error.code : 'seed.unexpected'
  console.error(`verify-bundled-seed [${code}]: ${message}`)
  process.exitCode = 1
})
