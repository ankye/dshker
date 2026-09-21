#!/usr/bin/env node
// Build the standalone dshkerd archive for one explicit target or for all
// supported targets. The archive is intentionally separate from Electron's
// release directory: the CLI is a different product and update channel.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const version = packageJson.version
const targets = {
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', archive: 'tar.gz', executable: 'dshkerd' },
  'darwin-x64': { platform: 'darwin', arch: 'x64', archive: 'tar.gz', executable: 'dshkerd' },
  'linux-arm64': { platform: 'linux', arch: 'arm64', archive: 'tar.gz', executable: 'dshkerd' },
  'linux-x64': { platform: 'linux', arch: 'x64', archive: 'tar.gz', executable: 'dshkerd' },
  'windows-arm64': {
    platform: 'win32',
    arch: 'arm64',
    archive: 'zip',
    executable: 'dshkerd.exe'
  },
  'windows-x64': { platform: 'win32', arch: 'x64', archive: 'zip', executable: 'dshkerd.exe' }
}

function usage() {
  console.log(`Build standalone dshkerd archives.

Usage:
  node tools/build-dshkerd-distribution.mjs [--target TARGET] [--output-dir DIR] [--overwrite]

TARGET is one of: ${Object.keys(targets).join(', ')}
`)
}

function parseArgs(argv) {
  const args = {
    target: undefined,
    outputDir: path.join(root, 'release', 'dshkerd'),
    overwrite: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--overwrite') args.overwrite = true
    else if (arg === '--target' || arg === '--output-dir') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      if (arg === '--target') args.target = value
      else args.outputDir = path.resolve(value)
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function ensureEmptyOutput(outputDir, archiveName, overwrite) {
  await mkdir(outputDir, { recursive: true })
  const archivePath = path.join(outputDir, archiveName)
  try {
    await stat(archivePath)
    if (!overwrite)
      throw new Error(`Output already exists: ${archivePath}; pass --overwrite explicitly`)
    await rm(archivePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return archivePath
}

async function buildTarget(target, outputDir, overwrite) {
  const info = targets[target]
  if (!info) throw new Error(`Unsupported target: ${target}`)
  const archiveName = `dshkerd-${version}-${target}.${info.archive}`
  const archivePath = await ensureEmptyOutput(outputDir, archiveName, overwrite)
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'dshkerd-dist-'))
  const packageDir = path.join(temporaryRoot, `dshkerd-${version}-${target}`)
  try {
    await mkdir(packageDir, { recursive: true })
    await run(
      process.execPath,
      [
        path.join(root, 'tools', 'build-peer-helper.mjs'),
        '--platform',
        info.platform,
        '--arch',
        info.arch
      ],
      { cwd: root }
    )
    const sourceDir = path.join(root, 'build', 'p2p', `${info.platform}-${info.arch}`)
    const sourceExecutable = path.join(sourceDir, info.executable)
    const sourceManifest = path.join(sourceDir, 'dshkerd-manifest.json')
    const executableBytes = await readFile(sourceExecutable)
    const source = JSON.parse(await readFile(sourceManifest, 'utf8'))
    if (source.target !== `${info.platform}-${info.arch}` || source.file !== info.executable) {
      throw new Error(`Embedded helper manifest target mismatch for ${target}`)
    }
    if (source.sha256 !== sha256(executableBytes))
      throw new Error(`Embedded helper checksum mismatch for ${target}`)
    await copyFile(sourceExecutable, path.join(packageDir, info.executable))
    await chmod(path.join(packageDir, info.executable), 0o755)
    const manifest = {
      schemaVersion: 1,
      version,
      target,
      executable: info.executable,
      sha256: source.sha256
    }
    await writeFile(
      path.join(packageDir, 'dshkerd-manifest.json'),
      JSON.stringify(manifest) + '\n',
      'utf8'
    )
    await writeFile(path.join(packageDir, 'VERSION'), `${version}\n`, 'utf8')
    const contents = await readdir(packageDir)
    if (
      contents.sort().join(',') !==
      [info.executable, 'VERSION', 'dshkerd-manifest.json'].sort().join(',')
    ) {
      throw new Error(`Unexpected files in ${target} archive staging directory`)
    }
    if (info.archive === 'tar.gz') {
      await run('tar', ['-czf', archivePath, '-C', temporaryRoot, path.basename(packageDir)])
    } else {
      await run('zip', ['-q', '-r', archivePath, path.basename(packageDir)], { cwd: temporaryRoot })
    }
    const archiveBytes = await readFile(archivePath)
    return {
      target,
      archive: archiveName,
      archiveSha256: sha256(archiveBytes),
      executable: info.executable,
      executableSha256: source.sha256
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return usage()
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`package.json version is not stable semver: ${version}`)
  const selected = args.target ? [args.target] : Object.keys(targets)
  const results = []
  for (const target of selected)
    results.push(await buildTarget(target, args.outputDir, args.overwrite))
  await writeFile(
    path.join(args.outputDir, `dshkerd-${version}-checksums.txt`),
    results.map((result) => `${result.archiveSha256}  ${result.archive}`).join('\n') + '\n',
    'utf8'
  )
  await writeFile(
    path.join(args.outputDir, `dshkerd-${version}-manifest.json`),
    JSON.stringify({ schemaVersion: 1, version, artifacts: results }, null, 2) + '\n',
    'utf8'
  )
  for (const result of results) console.log(JSON.stringify(result))
}

main().catch((error) => {
  console.error(`build-dshkerd-distribution: ${error.message}`)
  process.exitCode = 1
})
