#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  stat,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_RELEASE_DIR = 'release'
const MANIFEST_NAME = 'release-manifest.json'
const CHECKSUMS_NAME = 'checksums.txt'
const INTERNAL_OUTPUT_NAMES = new Set([
  'builder-debug.yml',
  'builder-effective-config.yaml',
  'ci-build.log',
  'release-smoke.log'
])

function usage() {
  console.log(`Generate or verify release metadata.

Usage:
  node tools/release-artifacts.mjs --release-dir release --mode package
  node tools/release-artifacts.mjs --release-dir release --verify

Options:
  --release-dir <path>  Release output directory. Default: release
  --mode <name>         Build mode recorded in the manifest.
  --verify             Recompute checksums from the manifest and fail on mismatch.
  --json               Print machine-readable output.
  --help               Show this help.
`)
}

function parseArgs(argv) {
  const args = {
    releaseDir: DEFAULT_RELEASE_DIR,
    mode: 'local',
    verify: false,
    json: false
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--verify') args.verify = true
    else if (arg === '--json') args.json = true
    else if (arg === '--release-dir' || arg === '--mode') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
      args[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
      i += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return args
}

function assertInside(parent, child, label) {
  const relative = path.relative(parent, child)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes expected root: ${child}`)
  }
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

async function hashFile(filePath) {
  const metadata = await lstat(filePath)
  if (metadata.isSymbolicLink()) return sha256(`symlink:${await readlink(filePath)}`)
  return sha256(await readFile(filePath))
}

async function listFiles(root) {
  const output = []

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.name === MANIFEST_NAME || entry.name === CHECKSUMS_NAME) continue
      if (entry.isDirectory()) await walk(fullPath)
      else if (entry.isFile() || entry.isSymbolicLink()) output.push(fullPath)
    }
  }

  await walk(root)
  return output.sort((a, b) => a.localeCompare(b))
}

async function summarizeFile(filePath, releaseDir) {
  const info = await stat(filePath)
  return {
    name: path.basename(filePath),
    relativePath: path.relative(releaseDir, filePath).replaceAll(path.sep, '/'),
    kind: 'file',
    sizeBytes: info.size,
    fileCount: 1,
    sha256: await hashFile(filePath)
  }
}

async function summarizeDirectory(dirPath, releaseDir) {
  const files = await listFiles(dirPath)
  const parts = []
  let sizeBytes = 0

  for (const file of files) {
    const info = await stat(file)
    const relativePath = path.relative(dirPath, file).replaceAll(path.sep, '/')
    const fileHash = await hashFile(file)
    parts.push(`${relativePath} ${fileHash}`)
    sizeBytes += info.size
  }

  return {
    name: path.basename(dirPath),
    relativePath: path.relative(releaseDir, dirPath).replaceAll(path.sep, '/'),
    kind: 'directory',
    sizeBytes,
    fileCount: files.length,
    sha256: sha256(`${parts.join('\n')}\n`)
  }
}

async function listTopLevelArtifacts(releaseDir) {
  const entries = await readdir(releaseDir, { withFileTypes: true })
  const artifacts = []

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === MANIFEST_NAME || entry.name === CHECKSUMS_NAME) continue
    if (entry.name.startsWith('.') || INTERNAL_OUTPUT_NAMES.has(entry.name)) continue
    const fullPath = path.join(releaseDir, entry.name)
    if (entry.isDirectory()) artifacts.push(await summarizeDirectory(fullPath, releaseDir))
    else if (entry.isFile()) artifacts.push(await summarizeFile(fullPath, releaseDir))
  }

  return artifacts
}

async function getGitRevision() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: appRoot,
      windowsHide: true
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

function getSigningStatus() {
  if (process.env.RELEASE_SIGNING_STATUS) return process.env.RELEASE_SIGNING_STATUS
  return 'unsigned-local'
}

function buildChecksumText(artifacts) {
  return `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.relativePath}`).join('\n')}\n`
}

async function generate(args) {
  const releaseDir = path.resolve(appRoot, args.releaseDir)
  assertInside(appRoot, releaseDir, 'Release directory')
  if (!(await exists(releaseDir)))
    throw new Error(`Release directory does not exist: ${args.releaseDir}`)

  await mkdir(releaseDir, { recursive: true })
  const packageJson = await readJson(path.join(appRoot, 'package.json'))
  const artifacts = await listTopLevelArtifacts(releaseDir)
  if (artifacts.length === 0) throw new Error(`No release artifacts found in ${args.releaseDir}`)

  const manifest = {
    schemaVersion: 1,
    appId: packageJson.build?.appId || packageJson.name,
    productName: packageJson.build?.productName || packageJson.name,
    version: packageJson.version,
    packageName: packageJson.name,
    buildMode: args.mode,
    buildTimestamp: new Date().toISOString(),
    gitRevision: await getGitRevision(),
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    osRelease: os.release(),
    signingStatus: getSigningStatus(),
    notarizationStatus: process.env.RELEASE_NOTARIZATION_STATUS || 'not-applicable-local',
    update: {
      channel: process.env.RELEASE_CHANNEL || 'local',
      feedUrlConfigured: Boolean(process.env.RELEASE_UPDATE_FEED_URL),
      minimumVersion: process.env.RELEASE_MINIMUM_VERSION || packageJson.version
    },
    artifacts,
    rollback: {
      previousVersion: process.env.RELEASE_PREVIOUS_VERSION || '',
      notes: process.env.RELEASE_ROLLBACK_NOTES || ''
    }
  }

  await writeFile(
    path.join(releaseDir, MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  )
  await writeFile(path.join(releaseDir, CHECKSUMS_NAME), buildChecksumText(artifacts), 'utf8')
  return { ok: true, releaseDir, artifacts: artifacts.length, manifest }
}

async function verify(args) {
  const releaseDir = path.resolve(appRoot, args.releaseDir)
  assertInside(appRoot, releaseDir, 'Release directory')
  const manifestPath = path.join(releaseDir, MANIFEST_NAME)
  const checksumsPath = path.join(releaseDir, CHECKSUMS_NAME)
  const manifest = await readJson(manifestPath)
  const artifacts = await listTopLevelArtifacts(releaseDir)
  const expectedByPath = new Map(
    manifest.artifacts.map((artifact) => [artifact.relativePath, artifact])
  )
  const issues = []

  for (const artifact of artifacts) {
    const expected = expectedByPath.get(artifact.relativePath)
    if (!expected) {
      issues.push(`Unexpected artifact: ${artifact.relativePath}`)
      continue
    }
    if (expected.sha256 !== artifact.sha256) {
      issues.push(`Checksum mismatch: ${artifact.relativePath}`)
    }
    if (expected.sizeBytes !== artifact.sizeBytes) {
      issues.push(`Size mismatch: ${artifact.relativePath}`)
    }
  }

  for (const expected of expectedByPath.values()) {
    if (!artifacts.some((artifact) => artifact.relativePath === expected.relativePath)) {
      issues.push(`Missing artifact: ${expected.relativePath}`)
    }
  }

  const checksumText = buildChecksumText(manifest.artifacts)
  const currentChecksumText = await readFile(checksumsPath, 'utf8')
  if (checksumText !== currentChecksumText) issues.push(`${CHECKSUMS_NAME} does not match manifest`)

  return {
    ok: issues.length === 0,
    releaseDir,
    artifacts: artifacts.length,
    issues
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }

  const result = args.verify ? await verify(args) : await generate(args)
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else if (result.ok) {
    console.log(
      args.verify
        ? `Release metadata verified for ${result.artifacts} artifact(s).`
        : `Release metadata written for ${result.artifacts} artifact(s).`
    )
  } else {
    for (const issue of result.issues) console.error(issue)
  }

  if (!result.ok) process.exitCode = 1
}

main().catch((error) => {
  console.error(`release-artifacts: ${error.message}`)
  process.exitCode = 1
})
