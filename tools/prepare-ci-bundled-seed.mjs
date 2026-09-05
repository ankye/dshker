#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { prepareBundledSeed } from './bundled-seed.mjs'

const execFileAsync = promisify(execFile)
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceSpecPath = path.join(appRoot, 'resources', 'bundled-seed', 'source.json')
const gitExecutable = process.env.DSH_BUNDLED_GIT_EXECUTABLE

/** Reads the exact public Harness revision that CI may embed in a Launcher package. */
async function readSourceSpec() {
  const value = JSON.parse(await readFile(sourceSpecPath, 'utf8'))
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.remoteUrl !== 'string' ||
    typeof value.branch !== 'string' ||
    typeof value.revision !== 'string' ||
    !/^https:\/\/github\.com\/deepseek-ai\/deepseek-harness\.git$/u.test(value.remoteUrl) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value.branch) ||
    !/^[0-9a-f]{40}$/u.test(value.revision)
  ) {
    throw new Error('Bundled seed source specification is invalid.')
  }
  return value
}

/** Runs the explicitly registered Git executable without a shell. */
async function runGit(arguments_) {
  if (gitExecutable === undefined || !path.isAbsolute(gitExecutable)) {
    throw new Error('DSH_BUNDLED_GIT_EXECUTABLE must name an absolute Git executable.')
  }
  await execFileAsync(gitExecutable, arguments_, {
    cwd: appRoot,
    timeout: 10 * 60 * 1_000,
    windowsHide: true
  })
}

async function main() {
  const source = await readSourceSpec()
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'dsh-launcher-harness-'))
  try {
    await runGit([
      'clone',
      '--branch',
      source.branch,
      '--single-branch',
      source.remoteUrl,
      temporaryRoot
    ])
    await runGit(['-C', temporaryRoot, 'checkout', '-B', source.branch, source.revision])
    const result = await prepareBundledSeed({
      sourceDirectory: await realpath(temporaryRoot),
      remoteUrl: source.remoteUrl,
      gitExecutable
    })
    console.log(`Bundled seed prepared for ${result.manifest.harness.revision}.`)
  } finally {
    // Windows runners can briefly keep a freshly-cloned Git packfile open
    // after the child process exits. Retry only the OS-reported transient
    // removal condition; a persistent cleanup failure remains release-fatal.
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 })
  }
}

main().catch((error) => {
  console.error(
    `prepare-ci-bundled-seed: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exitCode = 1
})
