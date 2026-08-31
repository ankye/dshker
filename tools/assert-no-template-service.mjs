#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const productionEntries = [
  'electron/main.ts',
  'electron/preload.ts',
  'electron/main/ipc.ts',
  'src/main.ts',
  'src/App.vue',
  'src/app/shell/AppShell.vue',
  'src/foundation/appMetadata.ts',
  'src/foundation/hostRuntime.ts',
  'packages/desktop-foundation/src/index.ts'
]
const prohibitedTokens = [
  'vfs-service',
  'createMemory',
  'sampleResources',
  'templateShellData',
  'providerRegistry'
]

export async function assertNoTemplateService() {
  const findings = []
  for (const relativePath of productionEntries) {
    const source = await readFile(path.join(appRoot, relativePath), 'utf8')
    for (const token of prohibitedTokens) {
      if (source.includes(token)) findings.push({ relativePath, token })
    }
  }

  return {
    ok: findings.length === 0,
    findings
  }
}

async function main() {
  const result = await assertNoTemplateService()
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('assert-no-template-service: ' + error.message)
    process.exitCode = 1
  })
}
