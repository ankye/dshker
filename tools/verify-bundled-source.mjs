#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// The staged seed has one canonical layout, produced by `seed:prepare` and
// structurally validated by `verify-bundled-seed.mjs`. This tool checks the Git
// bundle's own contents inside that layout, so it reads the same path.
const bundlePath = path.join(
  appRoot,
  'resources',
  'bundled-seed',
  'staged',
  'harness',
  'deepseek-harness.git.bundle'
)

async function run() {
  const metadata = await stat(bundlePath)
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error('Bundled DeepSeek Harness Git bundle is unavailable.')
  }
  await runGit(['bundle', 'verify', bundlePath])
  const refs = (await runGit(['bundle', 'list-heads', bundlePath]))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.split(' ')[1])
  if (!refs.includes('refs/heads/master')) {
    throw new Error('Bundled DeepSeek Harness Git bundle has no master branch.')
  }
  if (refs.some((ref) => !/^refs\/(heads\/master|tags\/dsh-v[0-9A-Za-z._-]+)$/u.test(ref))) {
    throw new Error('Bundled DeepSeek Harness Git bundle contains an unsupported ref.')
  }
}

function runGit(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/git', arguments_, {
      cwd: appRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let errorOutput = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Could not inspect bundled DeepSeek Harness Git bundle: ${errorOutput}`))
        return
      }
      resolve(output)
    })
  })
}

run().catch((error) => {
  console.error(`verify-bundled-source: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
