// Test evidence only. No subprocess, network operation, policy, or shared state.
import assert from 'node:assert/strict'

export function workbenchProgramPausePlans() {
  return [
    { name: 'short-process', direction: 'program', seconds: 3, repeats: 1, clear: 0 },
    { name: 'long-process', direction: 'program', seconds: 35, repeats: 1, clear: 0 },
    { name: 'flap-process', direction: 'program', seconds: 3, repeats: 5, clear: 3 }
  ]
}

function exactKeys(value, keys, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), label)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label}: exact fields required`)
}

// Go FILETIME is uint64 and exceeds JS's safe integer range. Parse its numeric
// token losslessly; JSON.parse/Number would silently alias distinct creations.
// Duplicate keys, floating numbers, arrays and trailing input are not receipts.
function integerJSON(source) {
  let offset = 0
  const space = () => {
    while (/[ \t\r\n]/.test(source[offset] ?? '') && offset < source.length) offset++
  }
  const string = () => {
    const start = offset++
    let escaped = false
    for (; offset < source.length; offset++) {
      const character = source[offset]
      if (!escaped && character === '"') return JSON.parse(source.slice(start, ++offset))
      if (!escaped && character === '\\') escaped = true
      else escaped = false
    }
    assert.fail('program pause JSON string is incomplete')
  }
  const value = () => {
    space()
    if (source[offset] === '"') return string()
    if (source[offset] === '{') {
      offset++
      const object = Object.create(null)
      space()
      if (source[offset] === '}') {
        offset++
        return object
      }
      while (offset < source.length) {
        space()
        assert.equal(source[offset], '"', 'program pause JSON key required')
        const key = string()
        assert(!Object.hasOwn(object, key), 'duplicate program pause JSON field')
        space()
        assert.equal(source[offset++], ':', 'program pause JSON colon required')
        object[key] = value()
        space()
        const delimiter = source[offset++]
        if (delimiter === '}') return object
        assert.equal(delimiter, ',', 'program pause JSON delimiter required')
      }
      assert.fail('program pause JSON object is incomplete')
    }
    for (const [token, decoded] of [
      ['true', true],
      ['false', false]
    ]) {
      if (source.startsWith(token, offset)) {
        offset += token.length
        return decoded
      }
    }
    const match = /^-?(?:0|[1-9]\d*)/.exec(source.slice(offset))
    assert(match, 'program pause JSON integer or supported value required')
    offset += match[0].length
    return BigInt(match[0])
  }
  const result = value()
  space()
  assert.equal(offset, source.length, 'trailing program pause JSON input')
  return result
}

function count(value, label, zero = false) {
  assert(typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value), `${label}: integer required`)
  const number = Number(value)
  assert(Number.isSafeInteger(number) && number >= (zero ? 0 : 1), `${label}: invalid integer`)
  return number
}

function jsonCount(value, label) {
  assert(typeof value === 'bigint' && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), label)
  return Number(value)
}

function instant(value) {
  assert.equal(typeof value, 'string', 'program pause timestamp required')
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value)
  assert(match, 'program pause UTC RFC3339Nano timestamp required')
  const milliseconds = Date.parse(`${match[1]}Z`)
  assert(
    Number.isSafeInteger(milliseconds) &&
      new Date(milliseconds).toISOString().slice(0, 19) === match[1],
    'invalid program pause calendar timestamp'
  )
  return BigInt(milliseconds) * 1000000n + BigInt((match[2] ?? '').padEnd(9, '0'))
}

function markerFields(source) {
  const result = Object.create(null)
  for (const token of source.split(/\s+/)) {
    const match = /^([A-Za-z][A-Za-z0-9]*)=([^\s=]+)$/.exec(token)
    assert(match, 'malformed program pause marker field')
    assert(!Object.hasOwn(result, match[1]), 'duplicate program pause marker field')
    result[match[1]] = match[2]
  }
  return result
}

function markers(text) {
  const result = { released: [], proof: [], readback: [], completed: [] }
  const names = Object.keys(result)
  text.split(/\r?\n/).forEach((line, index) => {
    const found = names.filter((name) => line.includes(`program-pause-${name}`))
    if (found.length === 0) return
    assert.equal(found.length, 1, 'multiple program pause markers on one line')
    const name = found[0]
    const marker = `program-pause-${name} `
    const position = line.indexOf(marker)
    assert(
      position >= 0 && line.indexOf(marker, position + 1) < 0,
      'malformed or duplicated program pause marker'
    )
    assert(position === 0 || /\s/.test(line[position - 1]), 'invalid program pause marker boundary')
    const source = line.slice(position + marker.length).trim()
    assert(source.length > 0, 'empty program pause marker')
    result[name].push({
      index,
      value: name === 'proof' ? integerJSON(source) : markerFields(source)
    })
  })
  return result
}

const proofKeys = [
  'id',
  'corePid',
  'creationSha',
  'identityVerified',
  'requestedHeldMilliseconds',
  'pausedAt',
  'pausedTickMilliseconds',
  'releaseStartedAt',
  'releaseStartedTickMilliseconds',
  'releasedAt',
  'releasedTickMilliseconds',
  'controllerPid',
  'cleanupConfirmed',
  'guardTerminatedController',
  'outcome',
  'errorCode'
]
const releaseKeys = [
  'case',
  'round',
  'heldMilliseconds',
  'identityVerified',
  'cleanupConfirmed',
  'outcome',
  'releaseStartedAt',
  'releaseStartedTickMilliseconds',
  'releasedAt'
]
const readbackKeys = [
  'direction',
  'case',
  'trigger',
  'pair',
  'attempt',
  'generation',
  'runtimeGeneration',
  'workspace',
  'session',
  'ws',
  'originalWS',
  'sameGateway',
  'sameCookie',
  'runtimePid'
]
const completedKeys = [
  'case',
  'repeats',
  'recoveryMilliseconds',
  'deadlineMilliseconds',
  'sameCookieSession',
  'windowsColdCalls',
  'macColdCalls',
  'originalWS',
  'noManualReconnect',
  'cleanupConfirmed',
  'firewallChanged',
  'networkChanged'
]

function pauseProcessIdentity(proof, plan, outcome = 'resumed') {
  exactKeys(proof, proofKeys, 'program pause proof')
  exactKeys(
    proof.creationSha,
    ['pid', 'parentPid', 'creation', 'executableSha256'],
    'program pause process identity'
  )
  assert.equal(proof.requestedHeldMilliseconds, BigInt(plan.seconds * 1000))
  const corePid = jsonCount(proof.corePid, 'exact core PID required')
  const parentPid = jsonCount(proof.creationSha.parentPid, 'exact parent PID required')
  const controllerPid = jsonCount(proof.controllerPid, 'exact controller PID required')
  assert.equal(proof.creationSha.pid, proof.corePid, 'core identity PID mismatch')
  assert(
    corePid !== parentPid && controllerPid !== corePid && controllerPid !== parentPid,
    'controller cannot be core or original runner'
  )
  assert(
    typeof proof.creationSha.creation === 'bigint' &&
      proof.creationSha.creation > 116444736000000000n &&
      proof.creationSha.creation <= 18446744073709551615n,
    'exact uint64 FILETIME creation required'
  )
  assert(
    typeof proof.creationSha.executableSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(proof.creationSha.executableSha256),
    'canonical core executable SHA required'
  )
  assert.equal(proof.identityVerified, true)
  assert.equal(proof.cleanupConfirmed, true)
  assert.equal(
    typeof proof.guardTerminatedController,
    'boolean',
    'explicit guard termination owner required'
  )
  if (outcome === 'resumed')
    assert.equal(
      proof.guardTerminatedController,
      false,
      'normal hold cannot terminate its controller'
    )
  assert.equal(
    proof.outcome,
    outcome,
    'exact resumed/profile or detached/preflight outcome required'
  )
  assert.equal(proof.errorCode, '')
  for (const field of [
    'pausedTickMilliseconds',
    'releaseStartedTickMilliseconds',
    'releasedTickMilliseconds'
  ])
    assert(
      typeof proof[field] === 'bigint' &&
        proof[field] > 0n &&
        proof[field] <= 18446744073709551615n,
      'same-machine monotonic lifecycle tick required'
    )
  assert(
    proof.releaseStartedTickMilliseconds >= proof.pausedTickMilliseconds &&
      proof.releasedTickMilliseconds >= proof.releaseStartedTickMilliseconds,
    'monotonic lifecycle ticks moved backwards'
  )
  // JSON-serializable exact creation, never a rounded Number.
  return {
    ...proof,
    corePid,
    controllerPid,
    pausedTickMilliseconds: proof.pausedTickMilliseconds.toString(),
    releaseStartedTickMilliseconds: proof.releaseStartedTickMilliseconds.toString(),
    releasedTickMilliseconds: proof.releasedTickMilliseconds.toString(),
    requestedHeldMilliseconds: plan.seconds * 1000,
    creationSha: {
      ...proof.creationSha,
      pid: corePid,
      parentPid,
      creation: proof.creationSha.creation.toString()
    }
  }
}

function pauseProofTiming(proof, release, plan, round) {
  exactKeys(release, releaseKeys, 'program pause release')
  assert.equal(release.case, plan.name, 'foreign release case')
  assert.equal(count(release.round, 'round'), round + 1, 'ordered unique rounds required')
  assert(count(release.heldMilliseconds, 'heldMilliseconds') >= plan.seconds * 1000)
  for (const field of ['identityVerified', 'cleanupConfirmed']) assert.equal(release[field], 'true')
  assert.equal(release.outcome, 'resumed')
  const pausedAt = instant(proof.pausedAt)
  const releaseStartedAt = instant(proof.releaseStartedAt)
  const releasedAt = instant(proof.releasedAt)
  assert(
    pausedAt >= (proof.creationSha.creation - 116444736000000000n) * 100n,
    'pause predates original process creation'
  )
  assert(
    releaseStartedAt - pausedAt >= BigInt(plan.seconds) * 1000000000n,
    'full real pause duration required'
  )
  assert(
    proof.releaseStartedTickMilliseconds - proof.pausedTickMilliseconds >=
      BigInt(plan.seconds * 1000),
    'full monotonic pause duration required'
  )
  assert(
    proof.releasedTickMilliseconds - proof.pausedTickMilliseconds <
      BigInt((plan.seconds + 15) * 1000),
    'monotonic hard lifetime exceeded'
  )
  assert(releasedAt >= releaseStartedAt, 'release timestamp moved backwards')
  assert(
    releasedAt - pausedAt < BigInt(plan.seconds + 15) * 1000000000n,
    'normal proof exceeded the immutable controller hard-lifetime ceiling'
  )
  assert.equal(
    instant(release.releaseStartedAt),
    releaseStartedAt,
    'release marker must match same-machine proof'
  )
  assert.equal(
    instant(release.releasedAt),
    releasedAt,
    'released marker must match same-machine proof'
  )
  assert(
    /^[1-9]\d*$/.test(release.releaseStartedTickMilliseconds),
    'exact release marker tick required'
  )
  assert.equal(
    BigInt(release.releaseStartedTickMilliseconds),
    proof.releaseStartedTickMilliseconds,
    'release marker tick must match native proof'
  )
  assert.equal(
    BigInt(release.heldMilliseconds),
    proof.releaseStartedTickMilliseconds - proof.pausedTickMilliseconds,
    'held marker must derive from real monotonic pause ticks'
  )
  return { pausedAt, releasedAt }
}

function pauseReadbacks(evidence, plan, finalIndex) {
  const directions = new Set()
  const attempts = new Set()
  const pairs = new Set()
  return evidence.readback.map(({ value, index }) => {
    const reverse = value.direction === 'mac-to-windows'
    exactKeys(
      value,
      reverse ? [...readbackKeys, 'engineAttempts'] : readbackKeys,
      'program pause readback'
    )
    assert(index > finalIndex, 'readback preceded final release')
    assert.equal(value.case, plan.name)
    assert(
      ['windows-to-macos', 'mac-to-windows'].includes(value.direction) &&
        !directions.has(value.direction),
      'both exact directions required'
    )
    directions.add(value.direction)
    assert.equal(value.trigger, reverse ? 'production-engine' : 'serve-periodic')
    if (reverse) count(value.engineAttempts, 'engineAttempts', true)
    assert(
      /^[a-f0-9]{12}$/.test(value.pair) && !pairs.has(value.pair),
      'exact directional pair required'
    )
    pairs.add(value.pair)
    assert(
      /^[a-f0-9]{32}$/.test(value.attempt) && !attempts.has(value.attempt),
      'distinct admitted candidate attempts required'
    )
    attempts.add(value.attempt)
    for (const field of ['generation', 'runtimeGeneration', 'runtimePid'])
      count(value[field], field)
    for (const field of ['workspace', 'session', 'ws'])
      assert(value[field].length > 0 && value[field].length <= 512)
    assert.equal(value.originalWS, plan.seconds === 3 ? 'true' : 'false')
    assert.equal(value.sameGateway, 'true')
    assert.equal(value.sameCookie, 'true')
    return value
  })
}

function pauseCompletion(evidence, plan) {
  const { value: completed, index: completedIndex } = evidence.completed[0]
  exactKeys(completed, completedKeys, 'program pause completed')
  assert(
    evidence.readback.every((item) => item.index < completedIndex),
    'completion preceded directional readback'
  )
  assert.equal(completed.case, plan.name)
  assert.equal(count(completed.repeats, 'repeats'), plan.repeats)
  assert(
    count(completed.recoveryMilliseconds, 'recoveryMilliseconds', true) < 25000,
    'original release-to-readback 25s deadline exceeded'
  )
  assert.equal(completed.deadlineMilliseconds, '25000')
  for (const field of ['sameCookieSession', 'noManualReconnect', 'cleanupConfirmed'])
    assert.equal(completed[field], 'true')
  for (const field of ['windowsColdCalls', 'macColdCalls']) assert.equal(completed[field], '1')
  for (const field of ['firewallChanged', 'networkChanged']) assert.equal(completed[field], 'false')
  assert.equal(completed.originalWS, plan.seconds === 3 ? 'true' : 'false')
  return completed
}

export function workbenchProgramPauseEvidence(windowsLog, exactCase) {
  assert.equal(typeof windowsLog, 'string', 'explicit Windows log required')
  assert.equal(typeof exactCase, 'string', 'exact program pause case required')
  const plan = workbenchProgramPausePlans().find((item) => item.name === exactCase)
  assert(plan, 'unknown program pause case')
  const evidence = markers(windowsLog)
  assert.equal(
    evidence.released.length,
    plan.repeats,
    'every program pause round requires one release'
  )
  assert.equal(
    evidence.proof.length,
    plan.repeats,
    'every program pause round requires one complete proof'
  )
  assert.equal(evidence.readback.length, 2, 'two directional program pause readbacks required')
  assert.equal(evidence.completed.length, 1, 'exactly one program pause completion required')
  const ids = new Set()
  let identity
  let previousRelease
  let previousTick
  let previousIndex = -1
  const proofs = evidence.proof.map(({ value: proof, index }, round) => {
    assert(
      typeof proof.id === 'string' && /^[a-f0-9]{32}$/.test(proof.id) && !ids.has(proof.id),
      'unique 128-bit pause ID required'
    )
    ids.add(proof.id)
    const normalized = pauseProcessIdentity(proof, plan)
    const currentIdentity = JSON.stringify([
      normalized.creationSha.pid,
      normalized.creationSha.parentPid,
      normalized.creationSha.creation,
      normalized.creationSha.executableSha256
    ])
    if (identity !== undefined)
      assert.equal(currentIdentity, identity, 'original held core identity changed')
    identity = currentIdentity
    const release = evidence.released[round]
    const { pausedAt, releasedAt } = pauseProofTiming(proof, release.value, plan, round)
    assert(Math.min(index, release.index) > previousIndex, 'round markers interleaved or reordered')
    previousIndex = Math.max(index, release.index)
    if (previousRelease !== undefined)
      assert(
        pausedAt - previousRelease >= BigInt(plan.clear) * 1000000000n,
        'flap clear interval missing'
      )
    previousRelease = releasedAt
    if (previousTick !== undefined) {
      assert(
        proof.pausedTickMilliseconds - previousTick >= BigInt(plan.clear * 1000),
        'flap monotonic lifecycle ticks moved backwards or lost clear interval'
      )
    }
    previousTick = proof.releasedTickMilliseconds
    return normalized
  })
  const readbacks = pauseReadbacks(evidence, plan, previousIndex)
  const completed = pauseCompletion(evidence, plan)
  return {
    plan,
    released: evidence.released.map((item) => item.value),
    proofs,
    readbacks,
    completed
  }
}

const preflightCases = [
  {
    name: 'TestWorkbenchRecoveryPauseControllerCrashLive',
    marker: 'program-pause-controller-crash'
  },
  { name: 'TestWorkbenchRecoveryPauseParentGoneGuardLive', marker: 'program-pause-parentgone' }
]

function preflightMarker(lines, item) {
  const found = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes(item.marker))
  assert.equal(found.length, 1, 'exactly one native pause cleanup marker required')
  const { line, index } = found[0]
  const marker = `${item.marker} proof=`
  const start = line.indexOf(marker)
  assert(start >= 0 && (start === 0 || /\s/.test(line[start - 1])), 'native pause marker malformed')
  const source = line.slice(start + marker.length)
  const end = source.lastIndexOf('}')
  assert(end > 0 && source[end + 1] === ' ', 'native complete JSON proof required')
  const proof = integerJSON(source.slice(0, end + 1))
  const fields = markerFields(source.slice(end + 2).trim())
  const keys = [
    'heldHandleAlive',
    'authenticatedRPC',
    'manualSecondResume',
    'firewallChanged',
    'networkChanged'
  ]
  const parentGone = item.marker === 'program-pause-parentgone'
  exactKeys(
    fields,
    parentGone ? [...keys, 'originalRunnerTerminated'] : keys,
    'native cleanup readback'
  )
  for (const key of ['heldHandleAlive', 'authenticatedRPC']) assert.equal(fields[key], 'true')
  for (const key of ['manualSecondResume', 'firewallChanged', 'networkChanged'])
    assert.equal(fields[key], 'false')
  if (parentGone) assert.equal(fields.originalRunnerTerminated, 'true')
  assert(
    typeof proof.id === 'string' && /^[a-f0-9]{32}$/.test(proof.id),
    'native pause nonce required'
  )
  const normalized = pauseProcessIdentity(proof, { seconds: 35 }, 'detached')
  assert.equal(
    proof.guardTerminatedController,
    parentGone,
    'native preflight release must match its actual termination owner'
  )
  const pausedAt = instant(proof.pausedAt)
  const releaseStartedAt = instant(proof.releaseStartedAt)
  const releasedAt = instant(proof.releasedAt)
  assert(pausedAt >= (proof.creationSha.creation - 116444736000000000n) * 100n)
  assert(
    releaseStartedAt >= pausedAt && releasedAt >= releaseStartedAt,
    'native cleanup clock order invalid'
  )
  assert(
    releaseStartedAt - pausedAt < 35000000000n,
    'preflight must kill its controller/runner while held, not after normal release'
  )
  assert(
    proof.releaseStartedTickMilliseconds - proof.pausedTickMilliseconds < 35000n,
    'native preflight did not interrupt the monotonic hold'
  )
  assert(
    proof.releasedTickMilliseconds - proof.pausedTickMilliseconds < 50000n,
    'native preflight exceeded monotonic hard lifetime'
  )
  assert(
    releasedAt - pausedAt < 50000000000n,
    'native cleanup exceeded its immutable hard lifetime'
  )
  return { index, proof: normalized, fields }
}

export function workbenchProgramPausePreflight(log) {
  assert.equal(typeof log, 'string', 'explicit native Windows preflight log required')
  assert(!/\b(?:FAIL|SKIP)\b/i.test(log), 'native pause preflight FAIL/Skip is release-blocking')
  const lines = log.split(/\r?\n/).filter((line) => line.trim().length > 0)
  assert.equal(lines.at(-1), 'PASS', 'native preflight final PASS required')
  assert.equal(
    lines.filter((line) => line === 'PASS').length,
    1,
    'unique native final PASS required'
  )
  const runs = lines
    .filter((line) => /^=== RUN\s+/.test(line))
    .map((line) => line.replace(/^=== RUN\s+/, ''))
  assert.deepEqual(
    runs.sort(),
    preflightCases.map((item) => item.name).sort(),
    'exact two native cleanup tests required'
  )
  const statuses = lines.filter((line) => /^--- PASS: /.test(line))
  assert.equal(statuses.length, 2, 'exact two unique native test PASS statuses required')
  const results = preflightCases.map((item) => {
    const status = new RegExp(`^--- PASS: ${item.name} \\([0-9]+(?:\\.[0-9]+)?s\\)$`)
    const passes = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => status.test(line))
    assert.equal(passes.length, 1, 'each exact native cleanup test must PASS once')
    const result = preflightMarker(lines, item)
    const runIndex = lines.findIndex((line) => line.replace(/^=== RUN\s+/, '') === item.name)
    assert(
      runIndex < result.index && result.index < passes[0].index,
      'native proof must belong to its live test execution'
    )
    return { name: item.name, proof: result.proof, fields: result.fields }
  })
  assert.notEqual(results[0].proof.id, results[1].proof.id, 'native preflights reused a nonce')
  assert.notDeepEqual(
    results[0].proof.creationSha,
    results[1].proof.creationSha,
    'native preflights reused an original core identity'
  )
  assert.equal(
    results[0].proof.creationSha.executableSha256,
    results[1].proof.creationSha.executableSha256,
    'native preflights did not exercise the same candidate binary'
  )
  return { controllerCrash: results[0], parentGone: results[1] }
}
