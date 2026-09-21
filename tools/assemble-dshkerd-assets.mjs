#!/usr/bin/env node
// Validate the standalone CLI artifacts downloaded from the six CI jobs and
// copy one verified set into ./publish for the GitHub Release.
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
const version = packageJson.version
const args = parseArgs(process.argv.slice(2))
const targets = [
  ['darwin', 'arm64', 'tar.gz'],
  ['darwin', 'x64', 'tar.gz'],
  ['windows', 'arm64', 'zip'],
  ['windows', 'x64', 'zip'],
  ['linux', 'arm64', 'tar.gz'],
  ['linux', 'x64', 'tar.gz']
]

function parseArgs(argv) {
  const parsed = { inputRoot: 'release-input', publishDir: 'publish' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--input-root' || arg === '--publish-dir') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      if (arg === '--input-root') parsed.inputRoot = value
      else parsed.publishDir = value
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node tools/assemble-dshkerd-assets.mjs [--input-root DIR] [--publish-dir DIR]'
      )
      process.exit(0)
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  return parsed
}

async function sha256(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

async function oneFile(root, name) {
  const files = (await readdir(root)).filter((file) => file === name)
  if (files.length !== 1) throw new Error(`Expected exactly one ${root}/${name}`)
  return path.join(root, name)
}

await mkdir(args.publishDir, { recursive: true })
const combined = []
for (const [platform, arch, extension] of targets) {
  const target = `${platform}-${arch}`
  const input = path.join(args.inputRoot, `dshkerd-${target}`)
  const archiveName = `dshkerd-${version}-${target}.${extension}`
  const archive = await oneFile(input, archiveName)
  const checksums = await oneFile(input, `dshkerd-${version}-checksums.txt`)
  const manifestPath = await oneFile(input, `dshkerd-${version}-manifest.json`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (
    manifest.schemaVersion !== 1 ||
    manifest.version !== version ||
    manifest.artifacts?.length !== 1
  ) {
    throw new Error(`${target} standalone manifest identity is invalid`)
  }
  const [artifact] = manifest.artifacts
  if (artifact.target !== target || artifact.archive !== archiveName) {
    throw new Error(`${target} standalone manifest target is invalid`)
  }
  const digest = await sha256(archive)
  if (digest !== artifact.archiveSha256)
    throw new Error(`${target} archive does not match manifest`)
  const rows = (await readFile(checksums, 'utf8')).trim().split(/\r?\n/)
  if (!rows.includes(`${digest}  ${archiveName}`))
    throw new Error(`${target} archive does not match checksums`)
  await copyFile(archive, path.join(args.publishDir, archiveName))
  combined.push(artifact)
}

await writeFile(
  path.join(args.publishDir, 'dshkerd-' + version + '-checksums.txt'),
  combined.map((artifact) => `${artifact.archiveSha256}  ${artifact.archive}`).join('\n') + '\n',
  'utf8'
)
await writeFile(
  path.join(args.publishDir, 'dshkerd-' + version + '-manifest.json'),
  JSON.stringify({ schemaVersion: 1, version, artifacts: combined }, null, 2) + '\n',
  'utf8'
)
await copyFile('tools/install-dshkerd.sh', path.join(args.publishDir, 'install-dshkerd.sh'))
await copyFile('tools/install-dshkerd.ps1', path.join(args.publishDir, 'install-dshkerd.ps1'))
await chmod(path.join(args.publishDir, 'install-dshkerd.sh'), 0o755)
console.log(JSON.stringify({ version, targets: combined.map((artifact) => artifact.target) }))
