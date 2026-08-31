#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') args.json = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function usage() {
  console.log(`Validate template package and release contract without resolving placeholders.

Usage:
  node tools/template-package-smoke.mjs --json
`)
}

async function readText(relativePath) {
  return readFile(path.join(appRoot, relativePath), 'utf8')
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath))
}

function check(checks, name, ok, details = '') {
  checks.push({ name, ok: Boolean(ok), details })
}

export async function runTemplatePackageSmoke(root = appRoot) {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const gitignore = await readFile(path.join(root, '.gitignore'), 'utf8')
  const releaseDocs = await readFile(path.join(root, 'docs/release.md'), 'utf8')
  const checks = []

  check(checks, 'template-placeholders-present', JSON.stringify(packageJson).includes('__APP_'))
  check(checks, 'script.package', Boolean(packageJson.scripts?.package))
  check(checks, 'script.dist', Boolean(packageJson.scripts?.dist))
  check(checks, 'script.release-metadata', Boolean(packageJson.scripts?.['release:metadata']))
  check(checks, 'script.release-verify', Boolean(packageJson.scripts?.['release:verify']))
  check(checks, 'script.release-smoke', Boolean(packageJson.scripts?.['release:smoke']))
  check(checks, 'script.release-readiness', Boolean(packageJson.scripts?.['release:readiness']))
  check(checks, 'script.environment-check', Boolean(packageJson.scripts?.['environment:check']))
  check(checks, 'engines.node', packageJson.engines?.node === '^20.19.0 || >=22.12.0')
  check(checks, 'engines.npm', packageJson.engines?.npm === '>=10.0.0')
  check(checks, 'build.appId', Boolean(packageJson.build?.appId))
  check(checks, 'build.productName', Boolean(packageJson.build?.productName))
  check(checks, 'build.output', packageJson.build?.directories?.output === 'release')
  check(checks, 'build.mac-target', Boolean(packageJson.build?.mac?.target?.length))
  check(checks, 'build.win-target', Boolean(packageJson.build?.win?.target?.length))
  check(checks, 'gitignore.release', gitignore.includes('release/'))
  check(checks, 'gitignore.run', gitignore.includes('.run/'))
  check(
    checks,
    'gitignore.certificates',
    gitignore.includes('*.p12') && gitignore.includes('*.pfx')
  )
  check(checks, 'docs.signing', releaseDocs.includes('Signing Handoff'))
  check(checks, 'docs.notarization', releaseDocs.includes('Notarization Handoff'))
  check(checks, 'docs.rollback', releaseDocs.includes('Rollback'))
  check(
    checks,
    'docs.readiness-evidence',
    releaseDocs.includes('.run/release-readiness/latest.json')
  )

  const failures = checks.filter((item) => !item.ok)
  const output = {
    ok: failures.length === 0,
    templateMode: true,
    packageName: packageJson.name,
    version: packageJson.version,
    checks,
    failures
  }

  const outputDir = path.join(root, '.run', 'release-readiness')
  await mkdir(outputDir, { recursive: true })
  await writeFile(
    path.join(outputDir, 'template-package-smoke.json'),
    `${JSON.stringify(output, null, 2)}\n`,
    'utf8'
  )
  return output
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }
  const result = await runTemplatePackageSmoke()
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else if (result.ok)
    console.log(`Template package contract passed for ${result.checks.length} checks.`)
  else
    for (const failure of result.failures)
      console.error(`Template package check failed: ${failure.name}`)

  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`template-package-smoke: ${error.message}`)
    process.exitCode = 1
  })
}
