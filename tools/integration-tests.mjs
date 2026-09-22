#!/usr/bin/env node
// Runs the Go integration suite with the external artefacts it requires.
//
// These tests drive two real peer processes against a real coordinator binary, and
// two of them drive a real DSH Harness. Both live outside this repository, so the
// suite reads their locations from the environment and fails when they are absent —
// deliberately, because silently skipping them would report a green suite that
// proved nothing.
//
// That design was sound and the consequence was not: nobody exported the variables,
// so twenty-five integration tests never ran once. Their absence was recorded as a
// "known baseline of fifteen failures" and treated as normal for months. This tool
// removes the manual step: the locations live in a config file, and running the
// suite is one command.
//
// Resolution order, first hit wins:
//   1. the current environment, so CI can override without a file
//   2. .env.local, then .env, at the app root
//   3. the documented default location for each artefact
//
// Nothing is guessed silently: every resolved path is printed with where it came
// from, and a missing artefact explains how to build it.
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The artefacts the suite needs, and how to get one when it is missing.
 *
 * `probe` is the file whose existence proves the artefact is built, which is not
 * always the path the variable holds: the Harness variable names a checkout root
 * while the thing that must exist is its built CLI entry point.
 */
const REQUIREMENTS = [
  {
    variable: 'DSHKER_SERVER_BINARY',
    purpose: 'the coordinator server the peer tests dial',
    default: path.join(homedir(), 'workspace/go_workspace/dshker-server/bin/dshker-server'),
    probe: (value) => value,
    hint: [
      'Build it from the coordinator checkout:',
      '  cd <coordinator-checkout>',
      '  go build -mod=readonly -trimpath -o bin/dshker-server ./cmd/dshker-server'
    ]
  },
  {
    variable: 'DSHKER_TEST_HARNESS_ROOT',
    purpose: 'a built DSH Harness checkout for the two real-DSH tests',
    default: path.join(homedir(), '.dshlauncher/harness'),
    probe: (value) => path.join(value, 'apps', 'cli', 'lib', 'bin.js'),
    hint: [
      'Launcher keeps one at ~/.dshlauncher/harness once the bundled Harness has',
      'been bootstrapped. The checkout must be built: apps/cli/lib/bin.js has to',
      'exist, which it does not in a fresh source-only clone.'
    ]
  }
]

/** Loads .env.local then .env, without overwriting anything already set. */
function loadConfigFiles() {
  const loaded = []
  for (const name of ['.env.local', '.env']) {
    const file = path.join(appRoot, name)
    if (!existsSync(file)) continue
    try {
      process.loadEnvFile(file)
      loaded.push(name)
    } catch (error) {
      // A malformed file is worth reporting: the alternative is a confusing
      // "artefact missing" for a value the file was supposed to supply.
      console.error(`warning: ${name} could not be read (${error.message})`)
    }
  }
  return loaded
}

function resolve(requirement, fromEnvironment) {
  const variable = requirement.variable
  if (fromEnvironment.has(variable)) {
    return { value: process.env[variable], origin: 'environment' }
  }
  if (typeof process.env[variable] === 'string' && process.env[variable].length > 0) {
    return { value: process.env[variable], origin: 'config file' }
  }
  return { value: requirement.default, origin: 'default' }
}

function describe(requirement, resolved) {
  const probe = requirement.probe(resolved.value)
  const present = existsSync(probe) && statSync(probe).isFile()
  return { ...resolved, probe, present }
}

const passthrough = process.argv.slice(2)
// Record which variables were already set before any file is read, so the report can
// distinguish a CI override from a config-file value.
const preset = new Set(
  REQUIREMENTS.map((entry) => entry.variable).filter(
    (name) => typeof process.env[name] === 'string' && process.env[name].length > 0
  )
)
const files = loadConfigFiles()

console.log(
  files.length > 0 ? `config: ${files.join(', ')}` : 'config: none (using defaults)'
)

const resolved = REQUIREMENTS.map((requirement) => ({
  requirement,
  state: describe(requirement, resolve(requirement, preset))
}))

for (const { requirement, state } of resolved) {
  const mark = state.present ? 'ok' : 'MISSING'
  console.log(`${mark.padEnd(8)}${requirement.variable}  ${state.value}  (${state.origin})`)
}

const missing = resolved.filter((entry) => !entry.state.present)
if (missing.length > 0) {
  console.error('')
  for (const { requirement, state } of missing) {
    console.error(`${requirement.variable} is not usable: ${requirement.purpose}`)
    console.error(`  expected this file to exist: ${state.probe}`)
    for (const line of requirement.hint) console.error(`  ${line}`)
    console.error('')
  }
  console.error(
    `Set the paths in .env.local at ${appRoot} to avoid passing them by hand, then run this again.`
  )
  process.exit(1)
}

const environment = { ...process.env }
for (const { requirement, state } of resolved) environment[requirement.variable] = state.value

const args = ['test', '-count=1', '-timeout=20m', './integration/', ...passthrough]
console.log(`\ngo ${args.join(' ')}\n`)
try {
  execFileSync('go', args, {
    cwd: path.join(appRoot, 'networking'),
    env: environment,
    stdio: 'inherit'
  })
} catch (error) {
  process.exit(typeof error.status === 'number' ? error.status : 1)
}
