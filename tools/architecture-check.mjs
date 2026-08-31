#!/usr/bin/env node
import { access, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ignoredDirectories = new Set([
  '.git',
  '.run',
  'dist',
  'dist-web',
  'node_modules',
  'out',
  'release'
])

async function exists(relativePath) {
  try {
    await access(path.join(appRoot, relativePath))
    return true
  } catch {
    return false
  }
}

async function listCodeFiles(directory) {
  const files = []
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(target)
      } else if (/\.(?:ts|vue|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        files.push(target)
      }
    }
  }
  await visit(directory)
  return files
}

function check(name, ok, detail) {
  return { name, ok, detail }
}

async function validateLineBudgets() {
  const roots = ['electron', 'src', 'tools']
  const issues = []
  for (const root of roots) {
    for (const filePath of await listCodeFiles(path.join(appRoot, root))) {
      const lines = (await readFile(filePath, 'utf8')).split(/\r?\n/).length
      if (lines > 1000) {
        issues.push({
          file: path.relative(appRoot, filePath).replaceAll(path.sep, '/'),
          lines
        })
      }
    }
  }
  return issues
}

export async function runArchitectureCheck() {
  const manifest = [
    'electron/main.ts',
    'electron/preload.ts',
    'electron/main/ipc.ts',
    'electron/main/protocol.ts',
    'src/shared/contracts.ts',
    'src/app/shell/AppShell.vue',
    'src/app/shared/i18n/i18n.ts',
    'src/styles/tokens.css',
    'tools/assert-no-template-service.mjs'
  ]
  const files = await Promise.all(
    manifest.map(async (relativePath) => [relativePath, await exists(relativePath)])
  )
  const source = await Promise.all(
    ['electron/preload.ts', 'electron/main/ipc.ts', 'src/app/shell/AppShell.vue'].map(
      async (relativePath) => readFile(path.join(appRoot, relativePath), 'utf8')
    )
  )
  const packageJson = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'))
  const lineBudgetIssues = await validateLineBudgets()
  const findings = [
    check(
      'ownership.manifest.exists',
      files.every(([, available]) => available),
      files.filter(([, available]) => !available).map(([relativePath]) => relativePath)
    ),
    check(
      'boundaries.import-graph',
      !source.join('\n').includes('@desktop-workspace/foundation/src'),
      'Production entry points must not import a private foundation module.'
    ),
    check(
      'foundation.drift',
      !source.join('\n').includes('templateShellData') &&
        !source.join('\n').includes('sampleResources') &&
        !source.join('\n').includes('vfs-service'),
      'Production entry points must not compose inherited template data or VFS.'
    ),
    check(
      'tooling.drift',
      packageJson.scripts['service:smoke'] === 'node tools/assert-no-template-service.mjs',
      'The service smoke command must prove the template service is absent.'
    ),
    check('line-budgets', lineBudgetIssues.length === 0, lineBudgetIssues)
  ]
  const failures = findings.filter((finding) => !finding.ok)
  return { ok: failures.length === 0, findings, failures }
}

async function main() {
  const result = await runArchitectureCheck()
  const json = process.argv.includes('--json')
  console.log(json ? JSON.stringify(result, null, 2) : JSON.stringify(result))
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('architecture-check: ' + error.message)
    process.exitCode = 1
  })
}
