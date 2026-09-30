#!/usr/bin/env node
/**
 * Prepare the Launcher's bundled Node/pnpm runtime.
 *
 * Reference: DeepSeek Harness Desktop scripts/prepare-runtime.ts. DSHKer ships
 * no separate Node executable: its own Electron binary runs in Node mode
 * (ELECTRON_RUN_AS_NODE=1 --expose-internals) and the pinned pnpm distribution
 * is staged beside the `node`/`pnpm` shell launchers it ships.
 *
 * The staged layout mirrors the reference:
 *   resources/runtime/
 *     bin/            node, node.cmd, pnpm, pnpm.cmd (shell launchers)
 *     pnpm/           the pinned pnpm package
 *     versions.json   { schemaVersion, node, pnpm }
 *
 * Version identity is a packaging gate, exactly as the reference requires: the
 * Node version is probed from the very Electron binary DSHKer will run, the
 * pnpm version is the pinned devDependency, and the pair is smoke-tested before
 * packing. `resources/runtime/` is generated output and is gitignored.
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const launcherRoot = fileURLToPath(new URL('..', import.meta.url))
const RUNTIME_ROOT = path.join(launcherRoot, 'resources', 'runtime')
const PNPM_DESTINATION = path.join(RUNTIME_ROOT, 'pnpm')
const BIN_DESTINATION = path.join(RUNTIME_ROOT, 'bin')
const VERSIONS_PATH = path.join(RUNTIME_ROOT, 'versions.json')
const BIN_SOURCE = path.join(launcherRoot, 'resources', 'runtime-bin')

/** A gate refusal: thrown so the verification logic is testable, translated to
 * stderr plus exit 1 by the CLI entry below. */
function fail(message) {
  throw new Error(`runtime:prepare: ${message}`)
}

/** The exact Electron executable DSHKer runs (and therefore its Node runtime). */
function electronExecutable() {
  try {
    const executable = require('electron')
    if (typeof executable !== 'string' || !path.isAbsolute(executable)) {
      fail('electron dependency did not resolve its packaged executable path')
    }
    return executable
  } catch (error) {
    fail(`electron dependency is not installed: ${String(error)}`)
  }
}

/** Probe the Node version bundled inside the Electron executable, like the reference. */
function probeNodeVersion(executable) {
  try {
    return execFileSync(executable, ['-p', 'process.versions.node'], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true
    }).trim()
  } catch (error) {
    fail(`could not probe the Electron Node version: ${String(error)}`)
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
    ELECTRON_RUN_AS_NODE: '1',
    PATH: [bin, process.env.PATH ?? ''].join(path.delimiter)
  }
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
function stagedPaths(runtimeRoot) {
  return {
    versionsPath: path.join(runtimeRoot, 'versions.json'),
    pnpmEntry: path.join(runtimeRoot, 'pnpm', 'bin', 'pnpm.mjs'),
    bin: path.join(runtimeRoot, 'bin')
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
export function verifyStagedRuntime(executable, runtimeRoot = RUNTIME_ROOT) {
  const { versionsPath, pnpmEntry, bin } = stagedPaths(runtimeRoot)
  if (!existsSync(versionsPath)) {
    fail(`no staged runtime at ${runtimeRoot}; run runtime:prepare first`)
  }
  const manifest = JSON.parse(readFileSync(versionsPath, 'utf8'))
  if (manifest?.schemaVersion !== 1) {
    fail(`staged runtime descriptor has an unknown schema: ${versionsPath}`)
  }
  const nodeVersion = probeNodeVersion(executable)
  if (manifest.node !== nodeVersion) {
    fail(
      `staged runtime node ${manifest.node} does not match the packaged Electron's ${nodeVersion}`
    )
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
if (isMain) {
  try {
    const verify = process.argv.includes('--verify')
    if (verify) {
      verifyStagedRuntime(electronExecutable())
    } else {
      rmSync(RUNTIME_ROOT, { recursive: true, force: true })
      mkdirSync(RUNTIME_ROOT, { recursive: true })

      const executable = electronExecutable()
      const nodeVersion = probeNodeVersion(executable)
      const { directory: pnpmDirectory, version: pnpmVersion } = pinnedPnpm()

      cpSync(pnpmDirectory, PNPM_DESTINATION, { recursive: true })
      cpSync(BIN_SOURCE, BIN_DESTINATION, { recursive: true })
      if (process.platform !== 'win32') {
        chmodSync(path.join(BIN_DESTINATION, 'node'), 0o755)
        chmodSync(path.join(BIN_DESTINATION, 'pnpm'), 0o755)
      }
      if (!existsSync(path.join(PNPM_DESTINATION, 'bin', 'pnpm.mjs'))) {
        fail(`staged pnpm distribution has no bin/pnpm.mjs entry: ${PNPM_DESTINATION}`)
      }

      writeFileSync(
        VERSIONS_PATH,
        `${JSON.stringify({ schemaVersion: 1, node: nodeVersion, pnpm: pnpmVersion }, undefined, 2)}\n`
      )

      smokePnpm(executable, path.join(PNPM_DESTINATION, 'bin', 'pnpm.mjs'), pnpmVersion)
      console.log(
        `runtime:prepare: staged ${RUNTIME_ROOT} (node ${nodeVersion} via Electron, pnpm ${pnpmVersion})`
      )
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
