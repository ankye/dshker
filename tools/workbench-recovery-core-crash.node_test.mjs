// Run with node --test; this suite validates the orchestration owner, not a DOM.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

// Evaluate the actual runner verifier without its SSH/build orchestration.
const source = readFileSync(new URL('./workbench-recovery-live.mjs', import.meta.url), 'utf8')
const begin = source.indexOf('function verifyCoreCrashCase(windows) {')
const end = source.indexOf('\nfunction verifyNetworkCase(', begin)
assert(begin > 0 && end > begin, 'actual runner core-crash proof verifier must exist')
const verify = runInNewContext(`${source.slice(begin, end)}; verifyCoreCrashCase`, { assert })
const timingBegin = source.indexOf('function scenarioSeconds(run) {')
const timingEnd = source.indexOf('\nconst windowsNode', timingBegin)
assert(timingBegin > 0 && timingEnd > timingBegin, 'actual runner lifetime functions required')
const processTimeout = runInNewContext(
  `${source.slice(timingBegin, timingEnd)}; windowsProcessTimeoutSeconds`
)
const valid = [
  'core-crash-injected injectionPerformed=true oldCorePid=101 exactIdentity=true waitJoined=true',
  'core-crash-restarted newCorePid=102 sameArgsEnv=true sameRoots=true identityRestored=true credentialRestoreObserved=true originalRuntimeAlive=true',
  'core-crash-completed sameGateway=true sameCookieSession=true originalRuntime=true noManualReconnect=true originalWS=false runtimeStarts=1 engineAttempts=2 recoveryMilliseconds=24999',
  'core-crash-runtime-cleanup pid=201 exactHandle=true reaped=true'
].join('\n')

test('one exact core crash requires original application identity and explicit old-carrier boundary', () => {
  assert.equal(verify(valid).completed.originalWS, 'false')
  assert.match(source, /requestedPhase === 'core-crash' && cases\.length === 1/)
})

test('outer crash process lifetime reserves exact-owner cleanup without changing recovery acceptance', () => {
  assert.equal(processTimeout({ phase: 'core-crash' }), 340)
  assert.match(source, /-test\.timeout=\$\{windowsProcessTimeoutSeconds\(run\)\}s/)
  assert.throws(() =>
    verify(valid.replace('recoveryMilliseconds=24999', 'recoveryMilliseconds=25000'))
  )
})

test('crash proof rejects no injection, duplicate injection, new runtime, manual recovery and late pass', () => {
  for (const [from, to] of [
    ['injectionPerformed=true', 'injectionPerformed=false'],
    ['exactIdentity=true', 'exactIdentity=false'],
    ['newCorePid=102', 'newCorePid=101'],
    ['sameRoots=true', 'sameRoots=false'],
    ['identityRestored=true', 'identityRestored=false'],
    ['credentialRestoreObserved=true', 'credentialRestoreObserved=false'],
    ['originalRuntimeAlive=true', 'originalRuntimeAlive=false'],
    ['sameCookieSession=true', 'sameCookieSession=false'],
    ['runtimeStarts=1', 'runtimeStarts=2'],
    ['noManualReconnect=true', 'noManualReconnect=false'],
    ['originalWS=false', 'originalWS=true'],
    ['engineAttempts=2', 'engineAttempts=0'],
    ['recoveryMilliseconds=24999', 'recoveryMilliseconds=25000'],
    ['exactHandle=true reaped=true', 'exactHandle=false reaped=false']
  ])
    assert.throws(() => verify(valid.replace(from, to)), undefined, `${from} must be fail-closed`)
  assert.throws(() => verify(valid + '\n' + valid.split('\n')[0]), /exactly one/)
  assert.throws(() => verify(valid.replace(/^core-crash-injected.*\n/, '')), /exactly one/)
})
