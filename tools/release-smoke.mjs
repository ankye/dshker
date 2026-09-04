#!/usr/bin/env node
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = {
    releaseDir: 'release',
    launch: false,
    json: false,
    launchTimeoutMs: 20_000
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') args.json = true
    else if (arg === '--launch') args.launch = true
    else if (arg === '--release-dir') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('Missing --release-dir value')
      args.releaseDir = value
      index += 1
    } else if (arg === '--launch-timeout-ms') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('Missing --launch-timeout-ms value')
      if (!/^\d+$/u.test(value) || Number(value) <= 0) {
        throw new Error('--launch-timeout-ms must be a positive integer')
      }
      args.launchTimeoutMs = Number(value)
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return args
}

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function assertInside(parent, child, label) {
  const relative = path.relative(parent, child)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes expected root`)
  }
}

function executableCandidates(releaseDir, manifest) {
  if (process.platform === 'win32') {
    return [path.join(releaseDir, 'win-unpacked', `${manifest.productName}.exe`)]
  }

  if (process.platform === 'darwin') {
    // electron-builder emits `mac` only for a plain x64 build and appends the
    // arch otherwise, so an Apple Silicon build lands in `mac-arm64`. Check both
    // spellings instead of assuming one layout.
    return ['mac', 'mac-arm64', 'mac-universal', 'mac-x64'].map((directory) =>
      path.join(
        releaseDir,
        directory,
        `${manifest.productName}.app`,
        'Contents',
        'MacOS',
        manifest.productName
      )
    )
  }

  return [
    path.join(releaseDir, 'linux-unpacked', manifest.productName),
    path.join(releaseDir, 'linux-unpacked', manifest.packageName)
  ]
}

function artifactNamesLookVersioned(manifest) {
  return manifest.artifacts.every((artifact) => {
    if (artifact.kind === 'directory') return true
    return artifact.name.includes(manifest.version)
  })
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return ''
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readTextWhenReady(filePath, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await exists(filePath)) {
      const content = await readFile(filePath, 'utf8')
      if (content.trim()) return content
    }
    await delay(100)
  }
  return ''
}

async function launchSmoke(executablePath, timeoutMs, releaseDir) {
  const outputDir = path.join(appRoot, '.run', 'release-smoke')
  const outputPath = path.join(outputDir, 'packaged-launch.json')
  const tracePath = path.join(releaseDir, 'release-smoke-launch.trace')
  const trace = []
  const recordTrace = async (message) => {
    trace.push(`${new Date().toISOString()} ${message}`)
    await writeFile(tracePath, `${trace.join('\n')}\n`, 'utf8')
  }

  await mkdir(outputDir, { recursive: true })
  await recordTrace(`launch-start executable=${executablePath} timeoutMs=${timeoutMs}`)
  await rm(outputPath, { force: true })
  await rm(`${outputPath}.trace`, { force: true })

  const launchEnv = {
    ...process.env,
    DESKTOP_APP_SMOKE_OUTPUT: outputPath,
    DESKTOP_APP_SMOKE_TEST: '1',
    ELECTRON_SMOKE_OUTPUT: outputPath,
    ELECTRON_SMOKE_TEST: '1'
  }
  delete launchEnv.ELECTRON_RUN_AS_NODE

  let stdout = ''
  let stderr = ''
  let exitCode = 0

  try {
    const result = await execFileAsync(
      executablePath,
      ['--dshker-smoke', '--dshker-smoke-output', outputPath],
      {
        cwd: path.dirname(executablePath),
        env: launchEnv,
        timeout: timeoutMs,
        windowsHide: true
      }
    )
    stdout = result.stdout || ''
    stderr = result.stderr || ''
  } catch (error) {
    exitCode = typeof error.code === 'number' ? error.code : 1
    stdout = error.stdout || ''
    const errorText = error instanceof Error ? error.message : String(error)
    stderr = [error.stderr || '', errorText].filter(Boolean).join('\n')
    await recordTrace(`launch-error ${errorText}`)
  }

  const evidence = await readTextWhenReady(outputPath)
  if (await exists(`${outputPath}.trace`)) {
    const childTrace = await readFile(`${outputPath}.trace`, 'utf8')
    trace.push(...childTrace.trimEnd().split('\n').filter(Boolean))
    await writeFile(tracePath, `${trace.join('\n')}\n`, 'utf8')
  }
  await recordTrace(`launch-end exitCode=${exitCode} evidence=${evidence.trim().length > 0}`)
  return {
    stdout: (evidence || stdout).trim(),
    stderr: stderr.trim(),
    exitCode,
    timeoutMs,
    traceFile: path.relative(appRoot, tracePath).replaceAll(path.sep, '/'),
    evidenceFile: path.relative(appRoot, outputPath).replaceAll(path.sep, '/')
  }
}

function parseLaunchPayload(launch) {
  if (!launch?.stdout) return undefined
  try {
    return JSON.parse(launch.stdout)
  } catch {
    // Fall through to single-line payloads emitted by console logging.
  }
  const jsonLine = launch.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => line.startsWith('{') && line.endsWith('}'))
  if (!jsonLine) return undefined
  return JSON.parse(jsonLine)
}

function launchEvidenceChecks(payload, required) {
  if (!required) {
    return {
      launch: true,
      launchPayload: true,
      appIdentity: true,
      routeSmoke: true,
      rendererShellMounted: true,
      rendererShellElement: true,
      rendererText: true,
      preload: true,
      firstFrameNonblank: true,
      firstFrameNotSingleColor: true,
      rendererErrors: true
    }
  }

  return {
    launch: payload?.ok === true,
    launchPayload: Boolean(payload),
    appIdentity: payload?.checks?.appIdentity === true,
    routeSmoke: payload?.checks?.routeSmoke === true,
    heightAdaptation: payload?.checks?.heightAdaptation === true,
    rendererShellMounted: payload?.checks?.rendererShellMounted === true,
    rendererShellElement: payload?.checks?.rendererShellElement === true,
    rendererText: payload?.checks?.rendererText === true,
    preload: payload?.checks?.preload === true,
    firstFrameNonblank: payload?.checks?.firstFrameNonblank === true,
    firstFrameNotSingleColor: payload?.checks?.firstFrameNotSingleColor === true,
    rendererErrors: payload?.checks?.rendererErrors === true
  }
}

function launchPayloadMatchesManifest(payload, manifest, required) {
  if (!required) return true
  return (
    [manifest.appId, manifest.packageName].includes(payload?.app?.appId) &&
    payload?.app?.version === manifest.version &&
    Boolean(payload?.app?.name)
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const releaseDir = path.resolve(appRoot, args.releaseDir)
  assertInside(appRoot, releaseDir, 'Release directory')

  const manifestPath = path.join(releaseDir, 'release-manifest.json')
  const checksumsPath = path.join(releaseDir, 'checksums.txt')
  const manifest = await readJson(manifestPath)
  const checksumsExist = await exists(checksumsPath)
  const executable = await firstExisting(executableCandidates(releaseDir, manifest))
  const launch =
    args.launch && executable
      ? await launchSmoke(executable, args.launchTimeoutMs, releaseDir)
      : undefined
  const launchPayload = parseLaunchPayload(launch)

  const checks = {
    manifest: Boolean(manifest.schemaVersion && manifest.artifacts?.length),
    checksums: checksumsExist,
    artifactNames: artifactNamesLookVersioned(manifest),
    rollback: Boolean(manifest.rollback),
    updateMetadata: Boolean(manifest.update?.channel && manifest.update?.minimumVersion),
    unpackedExecutable: Boolean(executable),
    launchIdentityMatchesManifest: launchPayloadMatchesManifest(
      launchPayload,
      manifest,
      args.launch
    ),
    ...launchEvidenceChecks(launchPayload, args.launch)
  }
  const failureStages = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => ({
      stage: `release-smoke.${name}`,
      logPath: path
        .relative(appRoot, path.join(releaseDir, 'release-smoke.log'))
        .replaceAll(path.sep, '/')
    }))
  const output = {
    ok: Object.values(checks).every(Boolean),
    releaseDir,
    executable,
    checks,
    failureStages,
    launch,
    launchPayload
  }
  await writeFile(
    path.join(releaseDir, 'release-smoke.log'),
    `${JSON.stringify(output, null, 2)}\n`,
    'utf8'
  )

  if (args.json) console.log(JSON.stringify(output, null, 2))
  else if (output.ok) console.log('Release smoke checks passed.')
  else {
    for (const [name, ok] of Object.entries(checks)) {
      if (!ok) console.error(`Release smoke check failed: ${name}`)
    }
  }

  if (!output.ok) process.exitCode = 1
}

main().catch((error) => {
  console.error(`release-smoke: ${error.message}`)
  process.exitCode = 1
})
