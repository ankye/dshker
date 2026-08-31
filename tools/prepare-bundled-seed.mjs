#!/usr/bin/env node
import {
  BundledSeedError,
  bundledSeedStagingDirectory,
  prepareBundledSeed,
  readBundledSeedBuildInputs
} from './bundled-seed.mjs'

function usage() {
  console.log(`Prepare the exact DSH source seed embedded by package and dist builds.

Usage:
  DSH_BUNDLED_HARNESS_SOURCE=/absolute/dsh \\
  DSH_BUNDLED_HARNESS_REMOTE_URL=https://github.com/deepseek-ai/deepseek-harness.git \\
  DSH_BUNDLED_GIT_EXECUTABLE=/absolute/git \\
  node tools/prepare-bundled-seed.mjs [--output <absolute-path>] [--json]

The source checkout must be clean, at its Git root, have an origin exactly equal
to DSH_BUNDLED_HARNESS_REMOTE_URL, and use SHA-1 Git objects. The generated
resource contains a Git bundle and plugin-generation metadata only; it contains
no node_modules or source .git configuration.
`)
}

function parseArgs(argv) {
  const result = { outputDirectory: bundledSeedStagingDirectory, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') result.help = true
    else if (argument === '--json') result.json = true
    else if (argument === '--output') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('Missing value for --output')
      result.outputDirectory = value
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
  const inputs = readBundledSeedBuildInputs()
  const result = await prepareBundledSeed({ ...inputs, outputDirectory: args.outputDirectory })
  const payload = {
    ok: true,
    directory: result.directory,
    revision: result.manifest.harness.revision,
    remoteUrl: result.manifest.remoteUrl,
    pluginGenerationId: result.manifest.pluginGeneration.generationId
  }
  console.log(
    args.json ? JSON.stringify(payload, null, 2) : `Bundled seed prepared for ${payload.revision}.`
  )
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof BundledSeedError ? error.code : 'seed.unexpected'
  console.error(`prepare-bundled-seed [${code}]: ${message}`)
  process.exitCode = 1
})
