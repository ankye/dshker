#!/usr/bin/env node
/**
 * Prepare the Launcher's bundled standalone Node/pnpm runtime.
 *
 * DSH's native builtin loader requires a real Node V8 context. Electron's
 * ELECTRON_RUN_AS_NODE mode does not provide one, so package the official Node
 * distribution binary instead of using Electron as a Node substitute.
 *
 * The staged layout mirrors the reference:
 *   resources/runtime/
 *     bin/            node (or node.exe), pnpm, pnpm.cmd
 *     pnpm/           the pinned pnpm package
 *     versions.json   { schemaVersion, node, pnpm }
 *
 * Version identity is a packaging gate: the Node release and official archive
 * digest are pinned here, the pnpm version comes from its pinned devDependency,
 * and the extracted Node/pnpm pair is smoke-tested before packing.
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { sha256NodeHeaders } from './node-runtime-integrity.mjs'

const require = createRequire(import.meta.url)
const launcherRoot = fileURLToPath(new URL('..', import.meta.url))
const RUNTIME_ROOT = path.join(launcherRoot, 'resources', 'runtime')
const BIN_DESTINATION = path.join(RUNTIME_ROOT, 'bin')
const BIN_SOURCE = path.join(launcherRoot, 'resources', 'runtime-bin')
const NODE_VERSION = '22.23.3'
const NODE_RELEASE_BASE = `https://nodejs.org/dist/v${NODE_VERSION}`
const NODE_ARTIFACTS = Object.freeze({
  'darwin-arm64': Object.freeze({
    filename: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: '23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53'
  }),
  'darwin-x64': Object.freeze({
    filename: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    sha256: '8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8'
  }),
  'win32-arm64': Object.freeze({
    filename: `node-v${NODE_VERSION}-win-arm64.zip`,
    sha256: '33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535'
  }),
  'win32-x64': Object.freeze({
    filename: `node-v${NODE_VERSION}-win-x64.zip`,
    sha256: '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71'
  }),
  'linux-arm64': Object.freeze({
    filename: `node-v${NODE_VERSION}-linux-arm64.tar.gz`,
    sha256: '5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2'
  }),
  'linux-x64': Object.freeze({
    filename: `node-v${NODE_VERSION}-linux-x64.tar.gz`,
    sha256: '1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af'
  })
})

/** A gate refusal: thrown so the verification logic is testable, translated to
 * stderr plus exit 1 by the CLI entry below. */
function fail(message) {
  throw new Error(`runtime:prepare: ${message}`)
}

export function resolveRuntimeTarget(args = process.argv.slice(2)) {
  let platform = process.platform
  let arch = process.arch
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument !== '--platform' && argument !== '--arch') {
      if (argument === '--verify') continue
      fail(`unknown option: ${argument}`)
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`${argument} requires a value`)
    if (argument === '--platform') platform = value
    else arch = value
    index += 1
  }
  const key = `${platform}-${arch}`
  if (!Object.hasOwn(NODE_ARTIFACTS, key)) fail(`unsupported Node runtime target: ${key}`)
  return { platform, arch, key, ...NODE_ARTIFACTS[key] }
}

function nodeExecutable(runtimeRoot, target) {
  return path.join(runtimeRoot, 'bin', target.platform === 'win32' ? 'node.exe' : 'node')
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(filePath)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

async function downloadNodeArchive(target, directory) {
  const archivePath = path.join(directory, target.filename)
  const url = `${NODE_RELEASE_BASE}/${target.filename}`
  const response = await fetch(url)
  if (!response.ok || response.body === null) {
    fail(`official Node archive download failed (${response.status}): ${url}`)
  }
  const hash = createHash('sha256')
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    }
  })
  try {
    await pipeline(Readable.fromWeb(response.body), hashingStream, createWriteStream(archivePath))
  } catch (error) {
    fail(`official Node archive download failed: ${String(error)}`)
  }
  const actual = hash.digest('hex')
  if (actual !== target.sha256) {
    rmSync(archivePath, { force: true })
    fail(`official Node archive checksum mismatch for ${target.filename}`)
  }
  return archivePath
}

async function stageNodeDistribution(target, runtimeRoot, temporaryDirectory) {
  const archivePath = await downloadNodeArchive(target, temporaryDirectory)
  const extractDirectory = path.join(temporaryDirectory, 'extracted')
  mkdirSync(extractDirectory)
  const archiveRoot = `node-v${NODE_VERSION}-${target.platform === 'win32' ? 'win' : target.platform}-${target.arch}`
  const isWindows = target.platform === 'win32'
  const archiveEntry = isWindows ? `${archiveRoot}/node.exe` : `${archiveRoot}/bin/node`
  const licenseEntry = `${archiveRoot}/LICENSE`
  const headersEntry = `${archiveRoot}/include/node`
  try {
    execFileSync(
      'tar',
      [
        isWindows ? '-xf' : '-xzf',
        archivePath,
        '--strip-components',
        '1',
        '-C',
        extractDirectory,
        archiveEntry,
        licenseEntry,
        headersEntry
      ],
      { windowsHide: true }
    )
  } catch (error) {
    fail(`could not extract the official Node binary, license, and headers: ${String(error)}`)
  }
  const extractedBinary = isWindows
    ? path.join(extractDirectory, 'node.exe')
    : path.join(extractDirectory, 'bin', 'node')
  if (!existsSync(extractedBinary) || !statSync(extractedBinary).isFile()) {
    fail(`official Node archive has no expected binary: ${archiveEntry}`)
  }
  const binDirectory = path.join(runtimeRoot, 'bin')
  mkdirSync(binDirectory, { recursive: true })
  const destination = nodeExecutable(runtimeRoot, target)
  copyFileSync(extractedBinary, destination)
  if (!isWindows) chmodSync(destination, 0o755)
  const licensePath = path.join(extractDirectory, 'LICENSE')
  if (!existsSync(licensePath)) fail(`official Node archive has no license: ${licenseEntry}`)
  copyFileSync(licensePath, path.join(runtimeRoot, 'LICENSE.node'))
  const extractedHeaders = path.join(extractDirectory, 'include', 'node')
  let nodeHeadersSha256
  try {
    nodeHeadersSha256 = sha256NodeHeaders(extractedHeaders)
  } catch (error) {
    fail(`official Node archive has incomplete Node-API headers: ${String(error)}`)
  }
  const headersDestination = path.join(runtimeRoot, 'include', 'node')
  mkdirSync(path.dirname(headersDestination), { recursive: true })
  cpSync(extractedHeaders, headersDestination, { recursive: true, errorOnExist: true })
  return {
    executable: destination,
    sha256: await sha256File(destination),
    nodeHeadersSha256
  }
}

/** Probe the version of the staged standalone Node executable. */
function probeNodeVersion(executable) {
  try {
    return execFileSync(executable, ['-p', 'process.versions.node'], {
      encoding: 'utf8',
      windowsHide: true
    }).trim()
  } catch (error) {
    fail(`could not probe the standalone Node version: ${String(error)}`)
  }
}

/** The pinned pnpm distribution's package directory and version. */
function pinnedPnpm() {
  let manifestPath
  try {
    // pnpm exports only its package.json ("." → "./package.json"), so
    // require.resolve('pnpm') is the manifest path, exactly as the reference
    // Desktop's prepare-runtime.ts resolves it.
    manifestPath = require.resolve('pnpm')
  } catch (error) {
    fail(`the pinned pnpm devDependency is not installed: ${String(error)}`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    fail(`the pinned pnpm devDependency has no version: ${manifestPath}`)
  }
  return { directory: path.dirname(manifestPath), version: manifest.version }
}

/** Smoke the bundled pair the way the reference smoke does: a real pnpm run. */
function smokePnpm(executable, pnpmEntry, expectedVersion, bin = BIN_DESTINATION) {
  const environment = {
    ...process.env,
    PATH: [bin, process.env.PATH ?? ''].join(path.delimiter)
  }
  delete environment.ELECTRON_RUN_AS_NODE
  let version
  try {
    version = execFileSync(executable, ['--expose-internals', pnpmEntry, '--version'], {
      encoding: 'utf8',
      env: environment,
      windowsHide: true,
      timeout: 120000
    }).trim()
  } catch (error) {
    fail(`bundled pnpm smoke failed on the packaged runtime: ${String(error)}`)
  }
  if (version !== expectedVersion) {
    fail(`bundled pnpm reports ${version}, expected the pinned ${expectedVersion}`)
  }
}

/** The staged paths one runtime root is expected to hold. */
function stagedPaths(runtimeRoot, target) {
  return {
    versionsPath: path.join(runtimeRoot, 'versions.json'),
    pnpmEntry: path.join(runtimeRoot, 'pnpm', 'bin', 'pnpm.mjs'),
    bin: path.join(runtimeRoot, 'bin'),
    nodeExecutable: nodeExecutable(runtimeRoot, target),
    nodeHeaders: path.join(runtimeRoot, 'include', 'node')
  }
}

/**
 * Verify mode re-checks a staged runtime without rebuilding it, so a release
 * readiness pass (and CI) can prove the packaged pair still matches the pinned
 * versions and still runs together. This is the reference's "version identity is
 * a packaging gate" applied to the Launcher. The runtime root is parameterized
 * so the gate itself is testable against a scratch stage; the CLI always uses
 * the app's own resources/runtime.
 */
export async function verifyStagedRuntime(
  runtimeRoot = RUNTIME_ROOT,
  target = resolveRuntimeTarget()
) {
  const {
    versionsPath,
    pnpmEntry,
    bin,
    nodeExecutable: executable,
    nodeHeaders
  } = stagedPaths(runtimeRoot, target)
  if (!existsSync(versionsPath)) {
    fail(`no staged runtime at ${runtimeRoot}; run runtime:prepare first`)
  }
  const manifest = JSON.parse(readFileSync(versionsPath, 'utf8'))
  if (manifest?.schemaVersion !== 3) {
    fail(`staged runtime descriptor has an unknown schema: ${versionsPath}`)
  }
  if (manifest.platform !== target.platform || manifest.arch !== target.arch) {
    fail(`staged runtime target ${manifest.platform}-${manifest.arch} does not match ${target.key}`)
  }
  if (manifest.nodeArchive !== target.filename || manifest.nodeArchiveSha256 !== target.sha256) {
    fail(`staged Node archive identity does not match the pinned artifact for ${target.key}`)
  }
  if (manifest.node !== NODE_VERSION) {
    fail(`staged Node ${manifest.node} does not match pinned ${NODE_VERSION}`)
  }
  if (!existsSync(executable) || !statSync(executable).isFile()) {
    fail(`staged Node executable is missing: ${executable}`)
  }
  if ((await sha256File(executable)) !== manifest.nodeBinarySha256) {
    fail(`staged Node binary checksum does not match: ${executable}`)
  }
  let actualNodeHeadersSha256
  try {
    actualNodeHeadersSha256 = sha256NodeHeaders(nodeHeaders)
  } catch (error) {
    fail(`staged Node headers are missing or invalid: ${String(error)}`)
  }
  if (actualNodeHeadersSha256 !== manifest.nodeHeadersSha256) {
    fail(`staged Node headers checksum does not match: ${nodeHeaders}`)
  }
  const nodeVersion = probeNodeVersion(executable)
  if (manifest.node !== nodeVersion) {
    fail(`staged Node ${manifest.node} does not match executable ${nodeVersion}`)
  }
  const { directory: pnpmDirectory, version: pnpmVersion } = pinnedPnpm()
  if (manifest.pnpm !== pnpmVersion) {
    fail(`staged runtime pnpm ${manifest.pnpm} does not match the pinned ${pnpmVersion}`)
  }
  if (!existsSync(pnpmDirectory)) fail('pinned pnpm is not installed')
  smokePnpm(executable, pnpmEntry, pnpmVersion, bin)
  console.log(
    `runtime:verify: ${runtimeRoot} matches (node ${manifest.node}, pnpm ${manifest.pnpm})`
  )
}

// Run the CLI only when executed directly, so the module can be imported and
// the gate tested without re-staging the app's own runtime as an import effect.
const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
async function prepareRuntime(target = resolveRuntimeTarget()) {
  const temporaryDirectory = mkdtempSync(path.join(path.dirname(RUNTIME_ROOT), '.runtime-stage-'))
  const stagedRoot = path.join(temporaryDirectory, 'runtime')
  const previousRoot = path.join(temporaryDirectory, 'previous-runtime')
  const stagedBin = path.join(stagedRoot, 'bin')
  const stagedPnpm = path.join(stagedRoot, 'pnpm')
  let previousRuntimeMoved = false
  let preserveTemporaryDirectory = false
  try {
    mkdirSync(stagedBin, { recursive: true })
    const {
      executable,
      sha256: nodeBinarySha256,
      nodeHeadersSha256
    } = await stageNodeDistribution(target, stagedRoot, temporaryDirectory)
    const nodeVersion = probeNodeVersion(executable)
    if (nodeVersion !== NODE_VERSION) {
      fail(`downloaded Node reports ${nodeVersion}, expected pinned ${NODE_VERSION}`)
    }
    const { directory: pnpmDirectory, version: pnpmVersion } = pinnedPnpm()
    cpSync(pnpmDirectory, stagedPnpm, { recursive: true })
    cpSync(BIN_SOURCE, stagedBin, { recursive: true })
    if (target.platform !== 'win32') chmodSync(path.join(stagedBin, 'pnpm'), 0o755)
    if (!existsSync(path.join(stagedPnpm, 'bin', 'pnpm.mjs'))) {
      fail(`pinned pnpm distribution has no bin/pnpm.mjs entry: ${stagedPnpm}`)
    }
    const manifest = {
      schemaVersion: 3,
      platform: target.platform,
      arch: target.arch,
      node: nodeVersion,
      nodeArchive: target.filename,
      nodeArchiveSha256: target.sha256,
      nodeBinarySha256,
      nodeHeadersSha256,
      pnpm: pnpmVersion
    }
    writeFileSync(
      path.join(stagedRoot, 'versions.json'),
      `${JSON.stringify(manifest, undefined, 2)}\n`
    )
    smokePnpm(executable, path.join(stagedPnpm, 'bin', 'pnpm.mjs'), pnpmVersion, stagedBin)

    if (existsSync(RUNTIME_ROOT)) {
      renameSync(RUNTIME_ROOT, previousRoot)
      previousRuntimeMoved = true
    }
    try {
      renameSync(stagedRoot, RUNTIME_ROOT)
    } catch (error) {
      if (previousRuntimeMoved) {
        try {
          renameSync(previousRoot, RUNTIME_ROOT)
          previousRuntimeMoved = false
        } catch (restoreError) {
          preserveTemporaryDirectory = true
          fail(
            `could not install the verified stage; previous runtime preserved at ${previousRoot}: ${String(restoreError)}`
          )
        }
      }
      throw error
    }
    if (previousRuntimeMoved) {
      rmSync(previousRoot, { recursive: true, force: true })
      previousRuntimeMoved = false
    }
    console.log(
      `runtime:prepare: staged ${RUNTIME_ROOT} (${target.key}, standalone Node ${nodeVersion}, pnpm ${pnpmVersion})`
    )
  } finally {
    if (previousRuntimeMoved && !existsSync(RUNTIME_ROOT) && existsSync(previousRoot)) {
      try {
        renameSync(previousRoot, RUNTIME_ROOT)
        previousRuntimeMoved = false
      } catch {
        preserveTemporaryDirectory = true
      }
    }
    if (!preserveTemporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

if (isMain) {
  try {
    const target = resolveRuntimeTarget()
    if (process.argv.includes('--verify')) await verifyStagedRuntime(RUNTIME_ROOT, target)
    else await prepareRuntime(target)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
