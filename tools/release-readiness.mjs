#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runReadiness } from './release-readiness-core.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function usage() {
  console.log(`Run desktop release-readiness gates and write evidence.

Usage:
  node tools/release-readiness.mjs --json

Options:
  --skip-stage <id>        Skip a specific stage. Intended for local diagnosis.
  --stage-timeout-ms <ms>  Per-stage timeout. Default: 1200000.
  --json                   Emit machine-readable evidence.
  --help                   Show this help.
`)
}

function parseArgs(argv) {
  const args = {
    json: false,
    skipStages: [],
    stageTimeoutMs: 1000 * 60 * 20
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--json') args.json = true
    else if (arg === '--skip-stage') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('Missing --skip-stage value')
      args.skipStages.push(value)
      index += 1
    } else if (arg === '--stage-timeout-ms') {
      const value = Number(argv[index + 1])
      if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid --stage-timeout-ms value')
      args.stageTimeoutMs = value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }

  const evidence = await runReadiness({
    appRoot,
    skipStages: args.skipStages,
    stageTimeoutMs: args.stageTimeoutMs
  })

  if (args.json) console.log(JSON.stringify(evidence, null, 2))
  else if (evidence.ok) {
    console.log(`Release readiness passed for ${evidence.stages.length} stage(s).`)
  } else {
    for (const failure of evidence.failures) {
      console.error(`Release readiness failed: ${failure.stage} (${failure.logPath})`)
    }
  }

  if (!evidence.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`release-readiness: ${error.message}`)
    process.exitCode = 1
  })
}
