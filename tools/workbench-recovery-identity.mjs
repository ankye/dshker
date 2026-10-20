// Test orchestration only. This module never starts a candidate or remote command.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export function workbenchSourceDigest(root) {
  assert(path.isAbsolute(root), 'explicit absolute source root required')
  const listing = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8'
    }
  )
  assert.equal(listing.status, 0, 'cannot enumerate source identity')
  const deleted = spawnSync('git', ['ls-files', '--deleted', '-z'], {
    cwd: root,
    encoding: 'utf8'
  })
  assert.equal(deleted.status, 0, 'cannot enumerate explicit tracked source deletions')
  const deletedFiles = new Set(deleted.stdout.split('\0').filter(Boolean))
  const hash = createHash('sha256')
  const files = [...new Set(listing.stdout.split('\0').filter(Boolean))].sort()
  for (const file of files) {
    if (!/\.(?:go|ts|vue|mjs|json|mod|sum|ps1)$/i.test(file)) continue
    const absolute = path.join(root, file)
    if (deletedFiles.has(file)) {
      assert(!existsSync(absolute), 'declared source deletion unexpectedly exists')
      continue
    }
    assert(statSync(absolute).isFile(), 'source must be a regular file')
    hash.update(file).update('\0').update(readFileSync(absolute)).update('\0')
  }
  return hash.digest('hex')
}

export function workbenchDuplexRecoveryCycles(text, count) {
  assert(Number.isInteger(count) && count >= 3 && count <= 20, 'explicit recovery count required')
  const idle = [
    text.lastIndexOf('duplex-application-idle direction=mac-to-windows '),
    text.lastIndexOf('duplex-application-idle direction=windows-to-macos ')
  ]
  assert(
    idle.every((index) => index >= 0),
    'original bidirectional idle must precede recovery'
  )
  const matches = [
    ...text.matchAll(
      /duplex-recovery-cycle cycle=(\d+) forwardAttempt=([a-f0-9]{32}) forwardGeneration=(\d+) forwardElapsedMs=(\d+) reverseAttempt=([a-f0-9]{32}) reverseGeneration=(\d+) reverseElapsedMs=(\d+) sameGateways=true sameCookieSession=true trigger=production-autoconnect-engine/g
    )
  ]
  assert.equal(matches.length, count, 'all requested post-idle automatic cycles required')
  const attempts = new Set()
  let previousForward = 0
  let previousReverse = 0
  return matches.map((match, index) => {
    assert(match.index > Math.max(...idle), 'recovery before idle is not post-idle acceptance')
    const [cycle, forwardGeneration, forwardElapsedMs, reverseGeneration, reverseElapsedMs] = [
      match[1],
      match[3],
      match[4],
      match[6],
      match[7]
    ].map(Number)
    assert.equal(cycle, index + 1, 'cycles must be complete, ordered and unique')
    assert(Number.isSafeInteger(forwardGeneration) && forwardGeneration > previousForward)
    assert(Number.isSafeInteger(reverseGeneration) && reverseGeneration > previousReverse)
    assert(
      forwardElapsedMs >= 0 &&
        forwardElapsedMs <= 25000 &&
        reverseElapsedMs >= 0 &&
        reverseElapsedMs <= 25000,
      'original fault-to-readback 25s budget required'
    )
    for (const attempt of [match[2], match[5]]) {
      assert(!attempts.has(attempt), 'directional replacement reused an attempt')
      attempts.add(attempt)
    }
    previousForward = forwardGeneration
    previousReverse = reverseGeneration
    return {
      cycle,
      forwardAttempt: match[2],
      forwardGeneration,
      forwardElapsedMs,
      reverseAttempt: match[5],
      reverseGeneration,
      reverseElapsedMs
    }
  })
}
