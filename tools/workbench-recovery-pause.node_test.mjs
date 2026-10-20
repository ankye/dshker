// Run with node --test. These are parser tests, not native fault acceptance.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  workbenchProgramPausePlans,
  workbenchProgramPauseEvidence,
  workbenchProgramPausePreflight
} from './workbench-recovery-pause.mjs'

const creation = 134043120000000001n
const encode = (value) =>
  JSON.stringify(value, (_, item) =>
    typeof item === 'bigint' ? `RAW_INTEGER_${item}` : item
  ).replaceAll(/"RAW_INTEGER_(\d+)"/g, '$1')

function pauseLog(name) {
  const plan = workbenchProgramPausePlans().find((item) => item.name === name)
  assert(plan)
  const original = plan.seconds === 3
  const lines = []
  for (let index = 0; index < plan.repeats; index++) {
    const pausedAt = new Date(Date.UTC(2026, 9, 20, 1, 0, index * 7)).toISOString()
    const releaseStartedAt = new Date(Date.parse(pausedAt) + plan.seconds * 1000).toISOString()
    const releasedAt = new Date(Date.parse(releaseStartedAt) + 1).toISOString()
    const proof = {
      id: (index + 1).toString(16).padStart(32, '0'),
      corePid: 123,
      creationSha: { pid: 123, parentPid: 99, creation, executableSha256: 'a'.repeat(64) },
      identityVerified: true,
      requestedHeldMilliseconds: plan.seconds * 1000,
      pausedAt,
      pausedTickMilliseconds: 100000 + index * 7000 - plan.seconds * 1000,
      releaseStartedAt,
      releaseStartedTickMilliseconds: 100000 + index * 7000,
      releasedAt,
      releasedTickMilliseconds: 100001 + index * 7000,
      controllerPid: 456 + index,
      cleanupConfirmed: true,
      guardTerminatedController: false,
      outcome: 'resumed',
      errorCode: ''
    }
    lines.push(`    owned_test.go:123: program-pause-proof ${encode(proof)}`)
    lines.push(
      `    owned_test.go:124: program-pause-released case=${name} round=${index + 1} heldMilliseconds=${plan.seconds * 1000} identityVerified=true cleanupConfirmed=true outcome=resumed releaseStartedAt=${releaseStartedAt} releaseStartedTickMilliseconds=${100000 + index * 7000} releasedAt=${releasedAt}`
    )
  }
  for (const [index, direction] of ['windows-to-macos', 'mac-to-windows'].entries()) {
    const trigger = index === 0 ? 'serve-periodic' : 'production-engine'
    const attempts = index === 0 ? '' : ' engineAttempts=0'
    lines.push(
      `program-pause-readback direction=${direction} case=${name} trigger=${trigger} pair=${String(index + 1).repeat(12)} attempt=${String(index + 2).repeat(32)} generation=${index + 10} runtimeGeneration=${index + 20} workspace=workspace-${index} session=session-${index} ws=ws-${index} originalWS=${original} sameGateway=true sameCookie=true runtimePid=${index + 800}${attempts}`
    )
  }
  lines.push(
    `program-pause-completed case=${name} repeats=${plan.repeats} recoveryMilliseconds=24999 deadlineMilliseconds=25000 sameCookieSession=true windowsColdCalls=1 macColdCalls=1 originalWS=${original} noManualReconnect=true cleanupConfirmed=true firewallChanged=false networkChanged=false`
  )
  return lines.join('\n')
}

function editProof(log, ordinal, edit) {
  let index = 0
  return log
    .split('\n')
    .map((line) => {
      const marker = 'program-pause-proof '
      if (!line.includes(marker) || index++ !== ordinal) return line
      const [prefix, source] = line.split(marker)
      // Keep the uint64 numeric token intact while editing unrelated test fields.
      const proof = JSON.parse(source.replace(creation.toString(), `"${creation}"`))
      edit(proof)
      return (
        prefix +
        marker +
        encode(proof).replace(`"creation":"${creation}"`, `"creation":${creation}`)
      )
    })
    .join('\n')
}

test('program pause plans are fresh explicit process profiles, never network policy', () => {
  const plans = workbenchProgramPausePlans()
  assert.deepEqual(plans, [
    { name: 'short-process', direction: 'program', seconds: 3, repeats: 1, clear: 0 },
    { name: 'long-process', direction: 'program', seconds: 35, repeats: 1, clear: 0 },
    { name: 'flap-process', direction: 'program', seconds: 3, repeats: 5, clear: 3 }
  ])
  plans[0].seconds = 100
  plans.pop()
  assert.equal(workbenchProgramPausePlans()[0].seconds, 3)
  assert.equal(workbenchProgramPausePlans().length, 3)
})

test('complete short, long and repeated process receipts retain exact uint64 identity', () => {
  for (const { name, repeats, seconds } of workbenchProgramPausePlans()) {
    const evidence = workbenchProgramPauseEvidence(pauseLog(name), name)
    assert.equal(evidence.proofs.length, repeats)
    assert.equal(evidence.completed.originalWS, String(seconds === 3))
    assert.equal(evidence.proofs[0].creationSha.creation, creation.toString())
    assert.doesNotThrow(() => JSON.stringify(evidence))
    assert.equal(evidence.readbacks[0].runtimePid, '800')
  }
})

test('monotonic hold receipts reject forged short pauses and backwards release ticks despite valid UTC', () => {
  const valid = pauseLog('short-process')
  for (const edit of [
    (proof) => {
      proof.pausedTickMilliseconds = proof.releaseStartedTickMilliseconds - 2999
    },
    (proof) => {
      proof.pausedTickMilliseconds = 0
    },
    (proof) => {
      proof.releasedTickMilliseconds = proof.releaseStartedTickMilliseconds - 1
    },
    (proof) => {
      proof.releasedTickMilliseconds = proof.pausedTickMilliseconds + 18000
    }
  ])
    assert.throws(() => workbenchProgramPauseEvidence(editProof(valid, 0, edit), 'short-process'))
})

test('profile rejects missing/duplicate/foreign rounds and non-resumed cleanup', () => {
  const good = pauseLog('short-process')
  for (const [from, to] of [
    ['case=short-process', 'case=long-process'],
    ['round=1', 'round=2'],
    ['releaseStartedTickMilliseconds=100000', 'releaseStartedTickMilliseconds=100001'],
    ['heldMilliseconds=3000', 'heldMilliseconds=2999'],
    ['identityVerified=true', 'identityVerified=false'],
    ['cleanupConfirmed=true', 'cleanupConfirmed=false'],
    ['outcome=resumed', 'outcome=terminated'],
    ['sameCookie=true', 'sameCookie=false'],
    ['sameGateway=true', 'sameGateway=false'],
    ['originalWS=true', 'originalWS=false'],
    ['runtimeGeneration=20', 'runtimeGeneration=0'],
    ['runtimePid=800', 'runtimePid=0'],
    ['generation=10', 'generation=1.5'],
    ['windowsColdCalls=1', 'windowsColdCalls=2'],
    ['macColdCalls=1', 'macColdCalls=2'],
    ['recoveryMilliseconds=24999', 'recoveryMilliseconds=25000'],
    ['deadlineMilliseconds=25000', 'deadlineMilliseconds=35000'],
    ['firewallChanged=false', 'firewallChanged=true'],
    ['networkChanged=false', 'networkChanged=true'],
    ['noManualReconnect=true', 'noManualReconnect=false'],
    ['sameCookieSession=true', 'sameCookieSession=false'],
    ['direction=mac-to-windows', 'direction=windows-to-macos'],
    ['attempt=' + '2'.repeat(32), 'attempt=' + '2'.repeat(12)],
    ['pair=' + '1'.repeat(12), 'pair=unknown'],
    ['repeats=1', 'repeats=0'],
    ['trigger=serve-periodic', 'trigger=production-engine'],
    ['engineAttempts=0', 'engineAttempts=-1']
  ])
    assert.throws(
      () => workbenchProgramPauseEvidence(good.replace(from, to), 'short-process'),
      undefined,
      from
    )
  for (const line of good.split('\n')) {
    assert.throws(() => workbenchProgramPauseEvidence(good.replace(line, ''), 'short-process'))
    assert.throws(() => workbenchProgramPauseEvidence(good + '\n' + line, 'short-process'))
  }
  assert.throws(() => workbenchProgramPauseEvidence(good, 'long-process'))
  assert.throws(() => workbenchProgramPauseEvidence(good, 'unknown'))
  assert.throws(() => workbenchProgramPauseEvidence(good, {}))
})

test('proof rejects malformed JSON, every missing field, identity drift and nanos-short holds', () => {
  const good = pauseLog('short-process')
  for (const edit of [
    (p) => {
      p.id = 'unknown'
    },
    (p) => {
      p.corePid++
    },
    (p) => {
      p.controllerPid = p.corePid
    },
    (p) => {
      p.controllerPid = p.creationSha.parentPid
    },
    (p) => {
      p.creationSha.pid++
    },
    (p) => {
      p.creationSha.executableSha256 = 'not-sha'
    },
    (p) => {
      p.identityVerified = false
    },
    (p) => {
      p.cleanupConfirmed = false
    },
    (p) => {
      p.outcome = 'detached'
    },
    (p) => {
      p.errorCode = 'test.pause_cleanup_failed'
    },
    (p) => {
      p.pausedAt = '2026-10-20T01:00:00.000000001Z'
    },
    (p) => {
      p.pausedAt = '2026-02-30T01:00:00Z'
    },
    (p) => {
      p.releaseStartedAt = '2026-10-20T01:00:02.999999999Z'
    },
    (p) => {
      p.releasedAt = p.pausedAt
    },
    (p) => {
      p.releasedAt = '2026-10-20T01:00:18Z'
    },
    (p) => {
      p.requestedHeldMilliseconds = 35000
    },
    (p) => {
      p.releaseStartedTickMilliseconds = 0
    },
    (p) => {
      p.extra = true
    }
  ])
    assert.throws(() => workbenchProgramPauseEvidence(editProof(good, 0, edit), 'short-process'))
  const source = JSON.parse(good.split('program-pause-proof ')[1].split('\n')[0])
  for (const key of Object.keys(source)) {
    assert.throws(
      () =>
        workbenchProgramPauseEvidence(
          editProof(good, 0, (p) => {
            delete p[key]
          }),
          'short-process'
        ),
      undefined,
      key
    )
  }
  for (const key of Object.keys(source.creationSha)) {
    assert.throws(
      () =>
        workbenchProgramPauseEvidence(
          editProof(good, 0, (p) => {
            delete p.creationSha[key]
          }),
          'short-process'
        ),
      undefined,
      key
    )
  }
  for (const [from, to] of [
    ['"corePid":123', '"corePid":123,"corePid":123'],
    ['"pid":123', '"pid":123,"pid":123'],
    ['"corePid":123', '"corePid":1.23e2'],
    ['"creation":' + creation, '"creation":"' + creation + '"'],
    ['"creation":' + creation, '"creation":18446744073709551616'],
    ['program-pause-proof {', 'program-pause-proofX {'],
    ['round=1', 'round=1 round=1'],
    ['sameCookie=true', 'sameCookie=true garbage']
  ])
    assert.throws(
      () => workbenchProgramPauseEvidence(good.replace(from, to), 'short-process'),
      undefined,
      from
    )
})

test('flaps reject one-bit FILETIME drift, repeated nonce, missing clear time and interleaved receipts', () => {
  const good = pauseLog('flap-process')
  assert.throws(() =>
    workbenchProgramPauseEvidence(
      editProof(good, 2, (p) => {
        p.id = '1'.padStart(32, '0')
      }),
      'flap-process'
    )
  )
  const drift = good
    .split('\n')
    .map((line, index) =>
      index === 4 ? line.replace(creation.toString(), (creation + 1n).toString()) : line
    )
    .join('\n')
  assert.equal(Number(creation), Number(creation + 1n), 'fixture must expose Number aliasing')
  assert.throws(() => workbenchProgramPauseEvidence(drift, 'flap-process'))
  assert.throws(() =>
    workbenchProgramPauseEvidence(
      editProof(good, 1, (p) => {
        p.corePid = p.creationSha.pid = 124
      }),
      'flap-process'
    )
  )
  const lines = good.split('\n')
  ;[lines[1], lines[2]] = [lines[2], lines[1]]
  assert.throws(() => workbenchProgramPauseEvidence(lines.join('\n'), 'flap-process'))
  const early = good.replaceAll('01:00:07.', '01:00:05.').replaceAll('01:00:10.', '01:00:08.')
  assert.throws(() => workbenchProgramPauseEvidence(early, 'flap-process'))
  const completionFirst = good.split('\n')
  completionFirst.unshift(completionFirst.pop())
  assert.throws(() => workbenchProgramPauseEvidence(completionFirst.join('\n'), 'flap-process'))
})

function preflightLog() {
  const cases = [
    ['TestWorkbenchRecoveryPauseControllerCrashLive', 'program-pause-controller-crash'],
    ['TestWorkbenchRecoveryPauseParentGoneGuardLive', 'program-pause-parentgone']
  ]
  return (
    cases
      .map(([name, marker], index) => {
        const proof = {
          id: (100 + index).toString(16).padStart(32, '0'),
          corePid: 123 + index,
          creationSha: {
            pid: 123 + index,
            parentPid: 99 + index,
            creation: creation + BigInt(index),
            executableSha256: 'a'.repeat(64)
          },
          identityVerified: true,
          requestedHeldMilliseconds: 35000,
          pausedAt: '2026-10-20T01:00:00Z',
          pausedTickMilliseconds: 99000 + index * 7000,
          releaseStartedAt: '2026-10-20T01:00:01Z',
          releaseStartedTickMilliseconds: 100000 + index * 7000,
          releasedAt: '2026-10-20T01:00:01.001Z',
          releasedTickMilliseconds: 100001 + index * 7000,
          controllerPid: 456 + index,
          cleanupConfirmed: true,
          guardTerminatedController: index === 1,
          outcome: 'detached',
          errorCode: ''
        }
        const parentGone = index === 0 ? '' : ' originalRunnerTerminated=true'
        return `=== RUN   ${name}\n    owned_test.go:123: ${marker} proof=${encode(proof)}${parentGone} heldHandleAlive=true authenticatedRPC=true manualSecondResume=false firewallChanged=false networkChanged=false\n--- PASS: ${name} (1.00s)`
      })
      .join('\n') + '\nPASS\n'
  )
}

test('native preflight requires two independent exact early-death cleanup proofs, not profile resume', () => {
  const evidence = workbenchProgramPausePreflight(preflightLog())
  assert.equal(evidence.controllerCrash.proof.outcome, 'detached')
  assert.equal(evidence.parentGone.fields.originalRunnerTerminated, 'true')
  assert.notDeepEqual(
    evidence.controllerCrash.proof.creationSha,
    evidence.parentGone.proof.creationSha
  )
  assert.equal(evidence.controllerCrash.proof.creationSha.creation, creation.toString())
  assert.doesNotThrow(() => JSON.stringify(evidence))
  assert.throws(() => workbenchProgramPausePreflight(pauseLog('short-process')))
  assert.throws(() => workbenchProgramPauseEvidence(preflightLog(), 'short-process'))
})

test('native cleanup cannot claim the wrong guard termination owner or hide it in a normal profile', () => {
  assert.throws(() =>
    workbenchProgramPauseEvidence(
      editProof(pauseLog('short-process'), 0, (p) => {
        p.guardTerminatedController = true
      }),
      'short-process'
    )
  )
  const raw = preflightLog()
  assert.throws(() =>
    workbenchProgramPausePreflight(
      raw.replace('"guardTerminatedController":false', '"guardTerminatedController":true')
    )
  )
  assert.throws(() =>
    workbenchProgramPausePreflight(
      raw.replace('"guardTerminatedController":true', '"guardTerminatedController":false')
    )
  )
})

test('native preflight refuses missing, duplicate, skipped, forged, stale and terminated evidence', () => {
  const good = preflightLog()
  for (const [from, to] of [
    ['--- PASS:', '--- FAIL:'],
    ['--- PASS:', '--- SKIP:'],
    ['TestWorkbenchRecoveryPauseControllerCrashLive (1.00s)', 'DifferentTest (1.00s)'],
    ['heldHandleAlive=true', 'heldHandleAlive=false'],
    ['authenticatedRPC=true', 'authenticatedRPC=false'],
    ['manualSecondResume=false', 'manualSecondResume=true'],
    ['firewallChanged=false', 'firewallChanged=true'],
    ['networkChanged=false', 'networkChanged=true'],
    ['originalRunnerTerminated=true', 'originalRunnerTerminated=false'],
    ['"outcome":"detached"', '"outcome":"terminated"'],
    ['"outcome":"detached"', '"outcome":"resumed"'],
    ['"cleanupConfirmed":true', '"cleanupConfirmed":false'],
    ['"corePid":123', '"corePid":124'],
    ['"errorCode":""', '"errorCode":"test.pause_cleanup_failed"'],
    ['"releaseStartedAt":"2026-10-20T01:00:01Z"', '"releaseStartedAt":"2026-10-20T01:00:36Z"'],
    ['"creation":' + creation, '"creation":"' + creation + '"'],
    ['"corePid":123', '"corePid":123,"corePid":123'],
    ['program-pause-parentgone proof=', 'program-pause-parentgone proof=garbage'],
    [
      '"id":"' + (101).toString(16).padStart(32, '0') + '"',
      '"id":"' + (100).toString(16).padStart(32, '0') + '"'
    ]
  ])
    assert.throws(() => workbenchProgramPausePreflight(good.replace(from, to)), undefined, from)
  for (const line of good.trim().split('\n')) {
    assert.throws(
      () => workbenchProgramPausePreflight(good.replace(line, '')),
      undefined,
      `missing ${line}`
    )
    assert.throws(
      () => workbenchProgramPausePreflight(good + line + '\n'),
      undefined,
      `duplicate ${line}`
    )
  }
  assert.throws(() => workbenchProgramPausePreflight(good + 'not-final\n'))
  assert.throws(() => workbenchProgramPausePreflight(good.replace('"id":', '"extra":true,"id":')))
})
