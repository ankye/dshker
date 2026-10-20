#!/usr/bin/env node
// Test-only orchestration of isolated production cores on two physical hosts.
// No installed catalog, credential, DSH process or application is opened here.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  workbenchSourceDigest,
  workbenchDuplexRecoveryCycles
} from './workbench-recovery-identity.mjs'
import {
  workbenchProgramPauseEvidence,
  workbenchProgramPausePlans,
  workbenchProgramPausePreflight
} from './workbench-recovery-pause.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const networking = path.join(root, 'networking')
const values = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]
  const value = process.argv[index + 1]
  assert(name?.startsWith('--') && value && !value.startsWith('--'), 'named arguments required')
  assert(!values.has(name), `duplicate argument: ${name}`)
  values.set(name, value)
}
const required = [
  '--server-binary',
  '--harness-root',
  '--ssh-target',
  '--bind-ip',
  '--output-dir',
  '--cycles',
  '--idle-seconds',
  '--phase',
  '--windows-node',
  '--windows-harness-root'
]
assert.deepEqual([...values.keys()].sort(), [...required].sort(), 'exact test inputs required')
const serverBinary = values.get('--server-binary')
const harnessRoot = values.get('--harness-root')
const sshTarget = values.get('--ssh-target')
const bindIP = values.get('--bind-ip')
const cycles = Number(values.get('--cycles'))
const idleSeconds = Number(values.get('--idle-seconds'))
const requestedPhase = values.get('--phase')
assert(
  ['all', 'forward-stress', 'duplex', 'network-fault', 'program-pause', 'core-crash'].includes(
    requestedPhase
  ),
  'explicit test phase required'
)
const networkPlans = [
  { name: 'short-inbound', direction: 'inbound', seconds: 3, repeats: 1, clear: 0 },
  { name: 'short-outbound', direction: 'outbound', seconds: 3, repeats: 1, clear: 0 },
  { name: 'long-inbound', direction: 'inbound', seconds: 35, repeats: 1, clear: 0 },
  { name: 'long-outbound', direction: 'outbound', seconds: 35, repeats: 1, clear: 0 },
  { name: 'flap-both', direction: 'both', seconds: 3, repeats: 5, clear: 3 }
]
const programPlans = workbenchProgramPausePlans()
function scenarioSeconds(run) {
  if (run.phase === 'core-crash') return 250
  if (run.phase === 'duplex') return 180 + cycles * 60 + idleSeconds
  if (run.phase !== 'network-fault' && run.phase !== 'program-pause') return 180 + cycles * 30
  const plan = (run.phase === 'program-pause' ? programPlans : networkPlans).find(
    (item) => item.name === run.faultCase
  )
  assert(plan, 'exact approved fault case required')
  return 250 + plan.seconds * plan.repeats + plan.clear * (plan.repeats - 1)
}
function windowsProcessTimeoutSeconds(run) {
  // This outer process bound must let a failed test join its exact owners.
  // The core-crash business criterion remains 25s, followed by a failed 45s
  // observation; cleanup time can never turn that failure into acceptance.
  const cleanupSeconds = run.phase === 'core-crash' ? 90 : 60
  return scenarioSeconds(run) + cleanupSeconds
}
const windowsNode = values.get('--windows-node')
const windowsHarnessRoot = values.get('--windows-harness-root')
const output = path.resolve(root, values.get('--output-dir'))
for (const target of [serverBinary, harnessRoot]) {
  assert(path.isAbsolute(target) && existsSync(target), 'explicit existing absolute input required')
}
assert(statSync(serverBinary).isFile(), 'coordinator binary must be a regular file')
assert(existsSync(path.join(harnessRoot, 'apps/cli/lib/bin.js')), 'built real DSH CLI required')
assert(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(sshTarget), 'explicit SSH user and host required')
assert(/^\d+\.\d+\.\d+\.\d+$/.test(bindIP), 'explicit reachable IPv4 required')
for (const target of [windowsNode, windowsHarnessRoot]) {
  assert(/^[A-Za-z]:[\\/]/.test(target), 'explicit absolute Windows runtime input required')
  assert(!/[\r\n\0]/.test(target), 'invalid Windows runtime input')
}
assert(
  Number.isInteger(cycles) && cycles >= 3 && cycles <= 20,
  'explicit recovery cycles 3..20 required'
)
assert(
  Number.isInteger(idleSeconds) && idleSeconds >= 60 && idleSeconds <= 43200,
  'explicit real application idle seconds 60..43200 required'
)
assert(output.startsWith(path.join(root, '.run') + path.sep), 'evidence must stay under .run')
assert(spawnSync('git', ['check-ignore', '-q', output], { cwd: root }).status === 0)
assert(!existsSync(output), 'evidence output must be new; never overwrite an earlier attempt')
mkdirSync(output)

const runnerId = randomUUID()
const diagnosticProfile = 'state-and-cause'
const eventFile = path.join(output, 'run-events.jsonl')
const stateFile = path.join(output, 'run-state.json')
writeFileSync(eventFile, '', { flag: 'wx' })
let runState = {
  schemaVersion: 1,
  runnerId,
  runnerPid: process.pid,
  startedAt: new Date().toISOString(),
  status: 'starting',
  stage: 'validated-inputs',
  phase: null,
  runId: null,
  requestedPhase,
  requestedApplicationIdleSeconds: idleSeconds,
  diagnosticProfile,
  progress: {},
  firstFailure: null,
  exitResult: null
}

function publish(event, changes = {}) {
  runState = { ...runState, ...changes, updatedAt: new Date().toISOString() }
  appendFileSync(eventFile, JSON.stringify({ event, ...runState }) + '\n')
  const staging = path.join(output, `.run-state-${randomUUID()}.json.tmp`)
  writeFileSync(staging, JSON.stringify(runState, null, 2) + '\n', { flag: 'wx' })
  renameSync(staging, stateFile)
}
publish('started')
process.once('exit', (exitCode) => {
  if (runState.exitResult !== null) return
  process.exitCode = exitCode === 0 ? 1 : exitCode
  publish('exit-without-final-proof', {
    status: 'failed',
    stage: 'interrupted-before-final-proof',
    exitResult: {
      exitCode: process.exitCode,
      passed: false,
      reason: 'runner-exited-without-final-proof'
    }
  })
})

function diagnosticEnvironment(environment) {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([key]) => !/^PIONS?_LOG_/i.test(key) && key.toUpperCase() !== 'DSHKER_TURN_DEBUG'
      )
    ),
    PION_LOG_WARN: 'all',
    PION_LOG_INFO: 'ice,pc',
    DSHKER_TEST_DIAGNOSTIC_PROFILE: diagnosticProfile
  }
}

const coreMac = path.join(output, 'dshkerd-darwin-arm64')
const coreWin = path.join(output, 'dshkerd-windows-amd64.exe')
const testWin = path.join(output, 'integration-windows-amd64.test.exe')
const sshOptions = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']

function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function powershell(script) {
  return [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(
      `$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';` +
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;${script}`,
      'utf16le'
    ).toString('base64')
  ].join(' ')
}

const literal = (value) => `'${value.replaceAll("'", "''")}'`

function start(command, args, options = {}) {
  const log = options.log
  const descriptor = log ? openSync(log, 'wx') : undefined
  const process = spawn(command, args, {
    cwd: options.cwd ?? networking,
    env: options.diagnostics
      ? diagnosticEnvironment({ ...globalThis.process.env, ...options.env })
      : { ...globalThis.process.env, ...options.env },
    detached: options.detached === true,
    stdio:
      descriptor === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', descriptor, descriptor]
  })
  if (descriptor !== undefined) closeSync(descriptor)
  let text = ''
  process.stdout?.on('data', (data) => {
    text += data.toString()
  })
  process.stderr?.on('data', (data) => {
    text += data.toString()
  })
  const done = new Promise((resolve, reject) => {
    process.once('error', reject)
    process.once('exit', (code, signal) => {
      if (code !== 0) reject(new Error(`${command} exited ${code}/${signal}; ${log ?? text}`))
      else resolve(text)
    })
  })
  // Attach a rejection handler before another process is launched or awaited.
  done.catch(() => {})
  return { process, done }
}

async function command(executable, args, options) {
  return start(executable, args, options).done
}

async function waitHostReady(run) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (
      existsSync(run.configPath) &&
      existsSync(run.hostLog) &&
      readFileSync(run.hostLog, 'utf8').includes('cross-host-ready')
    )
      return
    const state = await Promise.race([
      run.host.done.then(() => 'ended'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 100))
    ])
    assert.notEqual(state, 'ended', 'physical host ended before publishing its test configuration')
  }
  throw new Error('physical test host did not become ready in 60 seconds')
}

function verifyGoLog(file, requiredTests) {
  const events = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert(
    !events.some((event) => event.Action === 'fail' || event.Action === 'skip'),
    'failed or skipped real test'
  )
  for (const test of requiredTests) {
    assert(
      events.some((event) => event.Test === test && event.Action === 'pass'),
      `missing passing test ${test}`
    )
  }
  return events
}

async function buildCandidates() {
  publish('build-started', { status: 'running', stage: 'build-candidates' })
  console.log('Build isolated candidates for the requested physical test phases')
  console.log(
    'Diagnostic profile=state-and-cause pionDefault=warn pionInfo=ice,pc packetTrace=false'
  )
  await command('go', ['build', '-trimpath', '-o', coreMac, './cmd/dshkerd'], {
    env: { GOOS: 'darwin', GOARCH: 'arm64' }
  })
  await command('go', ['build', '-trimpath', '-o', coreWin, './cmd/dshkerd'], {
    env: { GOOS: 'windows', GOARCH: 'amd64' }
  })
  await command('go', ['test', '-c', '-tags', 'live', '-o', testWin, './integration'], {
    env: { GOOS: 'windows', GOARCH: 'amd64' }
  })
}

async function inspectWindowsRuntime() {
  publish('runtime-inspection', { stage: 'inspect-explicit-windows-runtime' })
  const runtime = JSON.parse(
    await command('ssh', [
      ...sshOptions,
      sshTarget,
      powershell(
        `$node=${literal(windowsNode)};$harness=${literal(windowsHarnessRoot)};` +
          `$cli=Join-Path $harness 'apps\\cli\\lib\\bin.js';` +
          `if(!(Test-Path -LiteralPath $node -PathType Leaf) -or !(Test-Path -LiteralPath $cli -PathType Leaf)){throw 'explicit Windows runtime input missing'};` +
          `$version=(& $node '--version').Trim();if($LASTEXITCODE -ne 0){throw 'Windows node verification failed'};` +
          `$pkg=Get-Content -LiteralPath (Join-Path $harness 'apps\\cli\\package.json') -Raw | ConvertFrom-Json;` +
          `[pscustomobject]@{nodeVersion=$version;dshVersion=$pkg.version;nodeSha256=(Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant();cliSha256=(Get-FileHash -LiteralPath $cli -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json -Compress`
      )
    ])
  )
  for (const key of ['nodeVersion', 'dshVersion', 'nodeSha256', 'cliSha256'])
    assert(
      typeof runtime[key] === 'string' && runtime[key] !== '',
      'missing Windows runtime identity'
    )
  return runtime
}

function startMacHost(run) {
  // Never start a credential-owning Mac core: its Keychain namespace is shared.
  return start(
    'go',
    [
      'test',
      '-json',
      '-tags',
      'live',
      '-count=1',
      `-timeout=${scenarioSeconds(run) + 240}s`,
      './integration',
      '-run',
      '^TestWorkbenchRecoveryCrossHost$'
    ],
    {
      log: run.hostLog,
      detached: true,
      diagnostics: true,
      env: {
        DSHKER_SERVER_BINARY: serverBinary,
        DSHKER_TEST_HARNESS_ROOT: harnessRoot,
        DSHKER_TEST_CROSS_BIND_IP: bindIP,
        DSHKER_TEST_CROSS_CYCLES: String(cycles),
        DSHKER_TEST_CROSS_APPLICATION_IDLE_SECONDS: String(idleSeconds),
        DSHKER_TEST_CROSS_PHASE: run.phase,
        DSHKER_TEST_CROSS_NETWORK_FAULT_CASE: run.faultCase,
        DSHKER_TEST_CROSS_CONFIG: run.configPath
      }
    }
  )
}

async function runWindowsClient(run) {
  const temp = (
    await command('ssh', [...sshOptions, sshTarget, powershell('[System.IO.Path]::GetTempPath()')])
  ).trim()
  assert(/^[A-Za-z]:\\[^\r\n]+\\$/.test(temp), 'invalid Windows temporary root')
  run.remoteDirectory = `${temp}dshker-recovery-cross-${run.runId}`
  await command('ssh', [
    ...sshOptions,
    sshTarget,
    powershell(`New-Item -ItemType Directory -Path ${literal(run.remoteDirectory)} | Out-Null`)
  ])
  const remoteFile = (name) => path.win32.join(run.remoteDirectory, name)
  const scpTarget = run.remoteDirectory.replaceAll('\\', '/')
  for (const [local, name] of [
    [run.configPath, 'cross-test.json'],
    [coreWin, 'dshkerd.exe'],
    [testWin, 'integration.test.exe']
  ]) {
    await command('scp', [...sshOptions, local, `${sshTarget}:${scpTarget}/${name}`])
  }
  if (run.phase === 'program-pause') {
    run.pausePreflightLog = path.join(path.dirname(run.clientLog), 'pause-native-preflight.log')
    const preflight =
      `$env:DSHKER_TEST_CORE_BINARY=${literal(remoteFile('dshkerd.exe'))};` +
      `& ${literal(remoteFile('integration.test.exe'))} '-test.v' '-test.timeout=180s' '-test.run=^TestWorkbenchRecoveryPause(ControllerCrashLive|ParentGoneGuardLive)$';exit $LASTEXITCODE`
    await command('ssh', [...sshOptions, sshTarget, powershell(preflight)], {
      log: run.pausePreflightLog
    })
    run.pauseNativePreflight = workbenchProgramPausePreflight(
      readFileSync(run.pausePreflightLog, 'utf8')
    )
    for (const item of ['controllerCrash', 'parentGone'])
      assert.equal(
        run.pauseNativePreflight[item].proof.creationSha.executableSha256,
        digest(coreWin),
        'native preflight must exercise this exact frozen core binary'
      )
  }
  const script =
    `Get-ChildItem Env: | Where-Object {$_.Name -match '^PIONS?_LOG_' -or $_.Name -eq 'DSHKER_TURN_DEBUG'} | ForEach-Object {[Environment]::SetEnvironmentVariable($_.Name,$null,'Process')};` +
    `$env:PION_LOG_WARN='all';$env:PION_LOG_INFO='ice,pc';$env:DSHKER_TEST_DIAGNOSTIC_PROFILE=${literal(diagnosticProfile)};` +
    `$env:DSHKER_TEST_CORE_BINARY=${literal(remoteFile('dshkerd.exe'))};` +
    `$env:DSHKER_TEST_CROSS_CONFIG=${literal(remoteFile('cross-test.json'))};` +
    `$env:DSHKER_TEST_WINDOWS_NODE=${literal(windowsNode)};` +
    `$env:DSHKER_TEST_WINDOWS_HARNESS_ROOT=${literal(windowsHarnessRoot)};` +
    `& ${literal(remoteFile('integration.test.exe'))} '-test.v' '-test.timeout=${windowsProcessTimeoutSeconds(run)}s' '-test.run=^TestWorkbenchRecoveryCrossClient$';exit $LASTEXITCODE`
  await command('ssh', [...sshOptions, sshTarget, powershell(script)], { log: run.clientLog })
}

function verifyCase(run) {
  verifyGoLog(run.hostLog, ['TestWorkbenchRecoveryCrossHost'])
  const windows = readFileSync(run.clientLog, 'utf8')
  assert(
    windows.includes('--- PASS: TestWorkbenchRecoveryCrossClient'),
    'Windows candidate did not pass'
  )
  if (run.phase === 'network-fault') {
    run.networkEvidence = verifyNetworkCase(run, windows)
    return []
  }
  if (run.phase === 'program-pause') {
    assert(run.pauseNativePreflight, 'independent native cleanup preflight required before pause')
    run.programPauseEvidence = workbenchProgramPauseEvidence(windows, run.faultCase)
    return []
  }
  if (run.phase === 'core-crash') {
    run.crashEvidence = verifyCoreCrashCase(windows)
    return []
  }
  assert.equal(
    (windows.match(/cross-recovery cycle=/g) ?? []).length,
    run.phase === 'forward-stress' ? cycles : 0,
    'all requested physical recovery cycles required'
  )
  const markers = ['cross-resume-refusal', 'cross-refusal-recovered', 'cross-stopped-runtime']
  let idleEvidence = []
  if (run.phase === 'duplex') {
    run.duplexRecoveryEvidence = workbenchDuplexRecoveryCycles(windows, cycles)
    markers.push(
      'duplex-ready',
      'duplex-application-idle',
      'duplex-unaffected',
      'duplex-recovery-cycle',
      'reverse-resume-refusal',
      'reverse-stopped-runtime',
      'reverseCasesPassed=true'
    )
    idleEvidence = [
      ...windows.matchAll(
        /duplex-application-idle direction=(mac-to-windows|windows-to-macos) elapsedSeconds=(\d+\.\d+) businessHTTPDelta=0 businessWSDelta=0 originalWS=true ws=/g
      )
    ].map((match) => ({ direction: match[1], elapsedSeconds: Number(match[2]) }))
    assert.equal(
      idleEvidence.length,
      2,
      'two original directional application-idle proofs required'
    )
    assert.equal(new Set(idleEvidence.map((item) => item.direction)).size, 2)
    assert(
      idleEvidence.every(
        (item) => Number.isFinite(item.elapsedSeconds) && item.elapsedSeconds >= idleSeconds
      ),
      'every original workbench must remain application-idle for the real requested duration'
    )
  }
  for (const marker of markers)
    assert(windows.includes(marker), `missing physical state matrix marker: ${marker}`)
  return idleEvidence
}

function verifyCoreCrashCase(windows) {
  const fields = (text) =>
    Object.fromEntries(
      [...text.matchAll(/([A-Za-z][A-Za-z0-9]*)=([^\s]+)/g)].map((item) => [item[1], item[2]])
    )
  const lines = windows.split('\n')
  const injected = lines.filter((line) => line.includes('core-crash-injected ')).map(fields)
  const restarted = lines.filter((line) => line.includes('core-crash-restarted ')).map(fields)
  const completed = lines.filter((line) => line.includes('core-crash-completed ')).map(fields)
  assert.equal(injected.length, 1, 'exactly one intentional core crash required; no rerun')
  assert.equal(restarted.length, 1, 'one same-root restart required')
  assert.equal(completed.length, 1, 'original application recovery required, not runtime refusal')
  assert.equal(injected[0].exactIdentity, 'true')
  assert.equal(injected[0].waitJoined, 'true')
  assert.equal(injected[0].injectionPerformed, 'true')
  assert(Number(injected[0].oldCorePid) > 0)
  assert(Number(restarted[0].newCorePid) > 0 && restarted[0].newCorePid !== injected[0].oldCorePid)
  for (const key of [
    'sameArgsEnv',
    'sameRoots',
    'identityRestored',
    'credentialRestoreObserved',
    'originalRuntimeAlive'
  ])
    assert.equal(restarted[0][key], 'true')
  for (const key of ['sameGateway', 'sameCookieSession', 'originalRuntime', 'noManualReconnect'])
    assert.equal(completed[0][key], 'true')
  assert.equal(completed[0].originalWS, 'false', 'dead core carrier cannot be claimed original')
  assert.equal(completed[0].runtimeStarts, '1', 'no second runtime start may manufacture recovery')
  assert(Number(completed[0].engineAttempts) > 0)
  assert(
    Number(completed[0].recoveryMilliseconds) >= 0 &&
      Number(completed[0].recoveryMilliseconds) < 25000
  )
  assert(
    windows.includes('core-crash-runtime-cleanup ') &&
      windows.includes('exactHandle=true reaped=true'),
    'exact original DSH HANDLE cleanup required'
  )
  return { injected: injected[0], restarted: restarted[0], completed: completed[0] }
}

function verifyNetworkCase(run, windows) {
  const plan = networkPlans.find((item) => item.name === run.faultCase)
  assert(plan, 'exact fault plan required')
  const fields = (text) =>
    Object.fromEntries(
      [...text.matchAll(/([A-Za-z][A-Za-z0-9]*)=([^\s]+)/g)].map((item) => [item[1], item[2]])
    )
  const lines = windows.split('\n')
  const released = lines
    .filter((line) => line.includes(`network-fault-released case=${plan.name} `))
    .map(fields)
  assert.equal(released.length, plan.repeats, 'all requested fault rounds must release their rules')
  released.forEach((item, index) => {
    assert.equal(Number(item.round), index + 1)
    assert.equal(item.direction, plan.direction)
    assert.equal(item.activeRules, '0')
    assert.equal(item.identityVerified, 'true')
    assert(Number(item.heldMilliseconds) >= plan.seconds * 1000)
  })
  const proofs = [...windows.matchAll(/network-firewall-proof (\{[^\n]+\})/g)]
    .map((item) => JSON.parse(item[1]))
    .filter((item) => item.direction === plan.direction)
  assert.equal(proofs.length, plan.repeats, 'every pulse requires the real Windows firewall proof')
  for (const item of proofs) {
    assert(item.identityVerified && item.activeRules === 0 && item.corePID > 0)
    assert.equal(item.requestedMilliseconds, plan.seconds * 1000)
    assert(item.heldMilliseconds >= item.requestedMilliseconds)
    assert.equal(item.errorCode, '')
    assert.equal(item.cleanupError, '')
  }
  const readbacks = lines
    .filter((line) => line.includes('network-fault-readback direction='))
    .map(fields)
  assert.equal(readbacks.length, 2, 'two real directional network recovery readbacks required')
  assert.equal(new Set(readbacks.map((item) => item.direction)).size, 2)
  const original = plan.seconds === 3 ? 'true' : 'false'
  for (const item of readbacks) {
    assert.equal(item.case, plan.name)
    assert.equal(item.originalWS, original)
    assert.equal(item.sameGateway, 'true')
    assert.equal(item.sameCookie, 'true')
    for (const key of ['pair', 'attempt', 'generation', 'workspace', 'session', 'ws'])
      assert(item[key])
  }
  const completed = lines
    .filter((line) => line.includes(`network-fault-completed case=${plan.name} `))
    .map(fields)
  assert.equal(completed.length, 1)
  assert.equal(completed[0].noManualReconnect, 'true')
  assert.equal(completed[0].sameCookieSession, 'true')
  assert.equal(completed[0].activeRules, '0')
  assert.equal(Number(completed[0].repeats), plan.repeats)
  assert(
    Number(completed[0].recoveryMilliseconds) >= 0 &&
      Number(completed[0].recoveryMilliseconds) < 25000
  )
  return { case: plan.name, released, firewallProofs: proofs, readbacks }
}

async function cleanCase(run) {
  const errors = []
  if (run.host?.process.pid && run.host.process.exitCode === null) {
    // The detached group contains only this test's Go host and its children.
    // Never signal the installed Launcher/core or a process chosen by name.
    try {
      process.kill(-run.host.process.pid, 'SIGINT')
      await run.host.done.catch(() => {})
    } catch (error) {
      errors.push(error)
    }
  }
  if (run.remoteDirectory) {
    assert(
      run.remoteDirectory.endsWith(`dshker-recovery-cross-${run.runId}`),
      'refuse broad cleanup'
    )
    try {
      await command('ssh', [
        ...sshOptions,
        sshTarget,
        powershell(`Remove-Item -LiteralPath ${literal(run.remoteDirectory)} -Recurse -Force`)
      ])
    } catch (error) {
      errors.push(error)
    }
  }
  rmSync(run.scratch, { recursive: true })
  if (errors.length) throw new AggregateError(errors, 'test-only case cleanup failed')
}

async function executeCase(phase, faultCase = '') {
  const directory = faultCase ? path.join(output, phase, faultCase) : path.join(output, phase)
  mkdirSync(directory, { recursive: true })
  const scratch = mkdtempSync(path.join(tmpdir(), 'dshker-recovery-cross-'))
  const run = {
    phase,
    faultCase,
    scratch,
    runId: randomUUID(),
    configPath: path.join(scratch, 'cross-test.json'),
    hostLog: path.join(directory, 'physical-mac-host.jsonl'),
    clientLog: path.join(directory, 'physical-windows-client.log')
  }
  const startedAt = new Date().toISOString()
  let failure
  let idleEvidence = []
  console.log(`Start physical phase=${phase} faultCase=${faultCase} run=${run.runId}`)
  publish('phase-started', {
    phase,
    faultCase,
    runId: run.runId,
    stage: 'mac-host-starting',
    progress: {}
  })
  const monitor = setInterval(() => observeCase(run), 2000)
  monitor.unref()
  try {
    run.host = startMacHost(run)
    await waitHostReady(run)
    publish('host-ready', { stage: 'windows-client-running' })
    await runWindowsClient(run)
    await run.host.done
    idleEvidence = verifyCase(run)
  } catch (error) {
    failure = error
    publish('phase-failed', {
      stage: 'case-failure-cleanup',
      firstFailure: runState.firstFailure ?? {
        phase,
        runId: run.runId,
        at: new Date().toISOString(),
        error: error.message
      }
    })
  }
  clearInterval(monitor)
  observeCase(run)
  try {
    await cleanCase(run)
  } catch (error) {
    failure = new AggregateError(failure ? [failure, error] : [error], 'case or cleanup failed')
  }
  const result = {
    phase,
    faultCase,
    runId: run.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    passed: !failure,
    idleEvidence,
    duplexRecoveryEvidence: run.duplexRecoveryEvidence ?? null,
    networkEvidence: run.networkEvidence ?? null,
    programPauseEvidence: run.programPauseEvidence ?? null,
    pauseNativePreflight: run.pauseNativePreflight ?? null,
    crashEvidence: run.crashEvidence ?? null,
    error: failure ? failure.message : '',
    evidence: [
      run.hostLog,
      run.clientLog,
      ...(run.pausePreflightLog ? [run.pausePreflightLog] : [])
    ]
      .filter(existsSync)
      .map((file) => ({
        file: path.relative(output, file),
        sha256: digest(file)
      }))
  }
  writeFileSync(path.join(directory, 'case-result.json'), JSON.stringify(result, null, 2) + '\n', {
    flag: 'wx'
  })
  publish('phase-ended', { stage: result.passed ? 'phase-passed' : 'phase-failed' })
  console.log(`${result.passed ? 'CASE PASS' : 'CASE FAIL'}: ${phase} ${faultCase}`)
  return result
}

function observeCase(run) {
  const progress = { ...runState.progress }
  let changed = false
  for (const [role, file] of [
    ['mac', run.hostLog],
    ['windows', run.clientLog]
  ]) {
    if (!existsSync(file)) continue
    const contents = readFileSync(file, 'utf8')
    const lines = contents.split('\n')
    if (!contents.endsWith('\n')) lines.pop()
    for (const line of lines) {
      let message = line
      if (role === 'mac') {
        try {
          message = JSON.parse(line).Output ?? ''
        } catch {
          continue
        }
      }
      if (/--- FAIL:|original owned WS failed/.test(message) && !runState.firstFailure) {
        publish('first-test-failure-observed', {
          firstFailure: {
            phase: run.phase,
            runId: run.runId,
            role,
            at: new Date().toISOString(),
            marker: 'original-failure-retained-in-raw-log'
          }
        })
      }
      if (
        !/application-idle-progress direction=|idle-begin direction=|duplex-application-idle direction=/.test(
          message
        )
      )
        continue
      const fields = Object.fromEntries(
        [...message.matchAll(/([A-Za-z][A-Za-z0-9]*)=([^\s]+)/g)].map((match) => [
          match[1],
          match[2]
        ])
      )
      if (!['mac-to-windows', 'windows-to-macos'].includes(fields.direction)) continue
      const sample = { phase: run.phase, runId: run.runId, role, direction: fields.direction }
      sample.idleComplete = message.includes('duplex-application-idle')
      for (const key of [
        'ws',
        'pair',
        'attempt',
        'generation',
        'runtimeGeneration',
        'windowsRuntimePid',
        'macRuntimePid',
        'workspace',
        'session',
        'businessHTTPDelta',
        'businessWSDelta',
        'originalWS'
      ])
        if (fields[key] !== undefined) sample[key] = fields[key]
      sample.elapsedSeconds =
        fields.elapsedSeconds === undefined ? 0 : Number(fields.elapsedSeconds)
      if (!Number.isFinite(sample.elapsedSeconds)) continue
      const previous = progress[fields.direction]
      if (
        !previous ||
        sample.elapsedSeconds > previous.elapsedSeconds ||
        (sample.idleComplete && !previous.idleComplete) ||
        (role === 'windows' &&
          previous.role === 'mac' &&
          sample.elapsedSeconds >= previous.elapsedSeconds)
      ) {
        progress[fields.direction] = sample
        changed = true
      }
    }
  }
  if (changed)
    publish('application-idle-progress', {
      stage:
        runState.firstFailure?.runId === run.runId
          ? 'case-failure'
          : Object.values(progress).length === 2 &&
              Object.values(progress).every((item) => item.idleComplete)
            ? 'application-idle-complete'
            : 'application-idle',
      progress
    })
}

const before = workbenchSourceDigest(root)
publish('source-frozen', { sourceDigest: before })
let windowsRuntime = null
let macRuntime = null
let setupFailure = null
const phases =
  requestedPhase === 'all'
    ? [
        { phase: 'forward-stress', faultCase: '' },
        { phase: 'duplex', faultCase: '' }
      ]
    : requestedPhase === 'network-fault'
      ? networkPlans.map((item) => ({ phase: 'network-fault', faultCase: item.name }))
      : requestedPhase === 'program-pause'
        ? programPlans.map((item) => ({ phase: 'program-pause', faultCase: item.name }))
        : [{ phase: requestedPhase, faultCase: '' }]
const cases = []
// Cases have independent enrolled identities. A failed direction never skips the
// other phase, and the aggregate still fails if any requested case failed.
try {
  await buildCandidates()
  macRuntime = {
    dshVersion: JSON.parse(readFileSync(path.join(harnessRoot, 'apps/cli/package.json'), 'utf8'))
      .version,
    cliSha256: digest(path.join(harnessRoot, 'apps/cli/lib/bin.js')),
    nodeVersion: (await command('node', ['--version'])).trim()
  }
  windowsRuntime = await inspectWindowsRuntime()
  for (const item of phases) cases.push(await executeCase(item.phase, item.faultCase))
} catch (error) {
  setupFailure = error.message
  publish('runner-failed', {
    firstFailure: runState.firstFailure ?? { at: new Date().toISOString(), error: setupFailure }
  })
}
const sourceUnchanged = workbenchSourceDigest(root) === before
const macHarnessUnchanged =
  macRuntime !== null &&
  macRuntime.cliSha256 === digest(path.join(harnessRoot, 'apps/cli/lib/bin.js')) &&
  macRuntime.dshVersion ===
    JSON.parse(readFileSync(path.join(harnessRoot, 'apps/cli/package.json'), 'utf8')).version
const proof = {
  schemaVersion: 2,
  completedAt: new Date().toISOString(),
  sourceDigest: before,
  requestedPhase,
  cases,
  passed:
    !setupFailure &&
    sourceUnchanged &&
    macHarnessUnchanged &&
    cases.length === phases.length &&
    cases.every((item) => item.passed),
  setupFailure,
  diagnosticProfile,
  sourceUnchanged,
  macHarnessUnchanged,
  tier:
    requestedPhase === 'core-crash'
      ? 'physical-windows-core-crash-and-macos-production-engine-manager-real-dsh'
      : 'physical-windows-periodic-core-and-macos-production-engine-manager-real-dsh',
  sshTarget,
  bindIP,
  coordinatorSha256: digest(serverBinary),
  runtimes: {
    mac: macRuntime,
    windows: windowsRuntime
  },
  candidates: [coreMac, coreWin, testWin].filter(existsSync).map((file) => ({
    file: path.basename(file),
    sha256: digest(file)
  })),
  automaticPhysicalRecoveryCycles: cases.some(
    (item) => item.phase === 'forward-stress' && item.passed
  )
    ? cycles
    : 0,
  requestedApplicationIdleSeconds: idleSeconds,
  applicationIdleSecondsVerified: cases.some((item) => item.phase === 'duplex' && item.passed)
    ? idleSeconds
    : 0,
  recoveryDriver:
    requestedPhase === 'core-crash'
      ? 'surviving-macos-production-engine-and-manager-test-composition'
      : 'windows-production-serve-periodic-loop',
  coreRestartDriver:
    requestedPhase === 'core-crash'
      ? 'intentional-test-exact-command-restart-not-process-supervision'
      : null,
  reverseRecoveryDriver: 'production-engine-and-manager-test-composition-not-macos-serve',
  bidirectionalPostIdleRecoveryCycles: cases.some(
    (item) =>
      item.phase === 'duplex' && item.passed && item.duplexRecoveryEvidence?.length === cycles
  )
    ? cycles
    : 0,
  networkFaultRecoveryDrivers:
    requestedPhase === 'network-fault'
      ? {
          windows: 'production-serve-periodic-loop',
          mac: 'production-engine-and-manager-test-composition-not-macos-serve'
        }
      : null,
  networkFaultCasesVerified: cases
    .filter((item) => item.phase === 'network-fault' && item.passed)
    .map((item) => item.faultCase),
  coreCrashVerified:
    requestedPhase === 'core-crash' && cases.length === 1 && cases[0].passed && sourceUnchanged,
  completeNetworkFaultValidation:
    requestedPhase === 'network-fault' &&
    !setupFailure &&
    sourceUnchanged &&
    macHarnessUnchanged &&
    cases.length === networkPlans.length &&
    cases.every((item) => item.passed),
  programPauseCasesVerified: cases
    .filter((item) => item.phase === 'program-pause' && item.passed)
    .map((item) => item.faultCase),
  completeProgramPauseValidation:
    requestedPhase === 'program-pause' &&
    !setupFailure &&
    sourceUnchanged &&
    macHarnessUnchanged &&
    cases.length === programPlans.length &&
    cases.every(
      (item) =>
        item.passed && item.programPauseEvidence !== null && item.pauseNativePreflight !== null
    ),
  programPauseIsNotUDPLoss: requestedPhase === 'program-pause',
  completeBidirectionalValidation:
    !setupFailure &&
    sourceUnchanged &&
    macHarnessUnchanged &&
    requestedPhase === 'all' &&
    cases.length === phases.length &&
    cases.every((item) => item.passed),
  completeLongDurationGate:
    !setupFailure &&
    sourceUnchanged &&
    macHarnessUnchanged &&
    requestedPhase === 'all' &&
    idleSeconds >= 28800 &&
    cycles >= 10 &&
    cases.length === phases.length &&
    cases.every((item) => item.passed) &&
    cases.some((item) => item.phase === 'duplex' && item.duplexRecoveryEvidence?.length === cycles),
  installedAppsModified: false,
  physicalDesktopUiAcceptance: false
}
writeFileSync(
  path.join(output, 'physical-verification.json'),
  JSON.stringify(proof, null, 2) + '\n',
  { flag: 'wx' }
)
publish('exit-result', {
  status: proof.passed ? 'passed' : 'failed',
  stage: 'finished',
  exitResult: {
    exitCode: proof.passed ? 0 : 1,
    passed: proof.passed,
    completedAt: proof.completedAt,
    sourceUnchanged,
    proof: 'physical-verification.json'
  }
})
assert(proof.sourceUnchanged, 'source changed during verification; rerun final candidates')
assert(proof.passed, 'one or more physical cases failed; all failures retained')
console.log(`PASS: ${path.join(output, 'physical-verification.json')}`)
