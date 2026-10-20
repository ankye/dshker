// Run with node --test; keep native Node lifecycle hooks out of Vitest discovery.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  workbenchSourceDigest,
  workbenchDuplexRecoveryCycles
} from './workbench-recovery-identity.mjs'

function temporarySource(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'dshker-source-identity-'))
  t.after(() => rmSync(root, { recursive: true }))
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, 'isolated temporary Git operation failed')
  }
  git('init', '--quiet')
  return { root, git }
}

test('tracked and untracked PowerShell bytes both change the actual runner identity', (t) => {
  const { root, git } = temporarySource(t)
  const tracked = path.join(root, 'controller.ps1')
  writeFileSync(tracked, 'Write-Output "sentinel-a"\n', { flag: 'wx' })
  git('add', '--', 'controller.ps1')
  const initial = workbenchSourceDigest(root)
  writeFileSync(tracked, 'Write-Output "sentinel-b"\n')
  const modified = workbenchSourceDigest(root)
  assert.notEqual(modified, initial)
  const untracked = path.join(root, 'watchdog.PS1')
  writeFileSync(untracked, 'Write-Output "sentinel-c"\n', { flag: 'wx' })
  const added = workbenchSourceDigest(root)
  assert.notEqual(added, modified)
  writeFileSync(untracked, 'Write-Output "sentinel-d"\n')
  assert.notEqual(workbenchSourceDigest(root), added)
})

test('ignored evidence cannot conceal or substitute a PowerShell source mutation', (t) => {
  const { root } = temporarySource(t)
  writeFileSync(path.join(root, '.gitignore'), 'evidence.ps1\n', { flag: 'wx' })
  const source = path.join(root, 'controller.ps1')
  const evidence = path.join(root, 'evidence.ps1')
  writeFileSync(source, 'Write-Output "source-a"\n', { flag: 'wx' })
  writeFileSync(evidence, 'Write-Output "evidence-a"\n', { flag: 'wx' })
  const initial = workbenchSourceDigest(root)
  writeFileSync(evidence, 'Write-Output "evidence-b"\n')
  assert.equal(workbenchSourceDigest(root), initial)
  writeFileSync(source, 'Write-Output "source-b"\n')
  assert.notEqual(workbenchSourceDigest(root), initial)
})

test('the runner uses the tested identity module and has no duplicate digest implementation', () => {
  const runner = readFileSync(new URL('./workbench-recovery-live.mjs', import.meta.url), 'utf8')
  assert.match(
    runner,
    /import \{\s+workbenchSourceDigest,\s+workbenchDuplexRecoveryCycles\s+\} from '\.\/workbench-recovery-identity\.mjs'/
  )
  assert.equal((runner.match(/workbenchSourceDigest\(root\)/g) ?? []).length, 2)
  assert.doesNotMatch(runner, /function sourceDigest\(/)
})

test('explicit tracked deletions change source identity without depending on staging', (t) => {
  const { root, git } = temporarySource(t)
  writeFileSync(path.join(root, 'owner.go'), 'package owner\n', { flag: 'wx' })
  git('add', '--', 'owner.go')
  const before = workbenchSourceDigest(root)
  rmSync(path.join(root, 'owner.go'))
  const deleted = workbenchSourceDigest(root)
  assert.notEqual(deleted, before)
  git('add', '-u', '--', 'owner.go')
  assert.equal(workbenchSourceDigest(root), deleted)
})

function cycleProof(cycle) {
  return `duplex-recovery-cycle cycle=${cycle} forwardAttempt=${cycle.toString(16).padStart(32, '0')} forwardGeneration=${cycle} forwardElapsedMs=1200 reverseAttempt=${(cycle + 20).toString(16).padStart(32, '0')} reverseGeneration=${cycle} reverseElapsedMs=1500 sameGateways=true sameCookieSession=true trigger=production-autoconnect-engine`
}
const idleProof =
  'duplex-application-idle direction=mac-to-windows elapsedSeconds=28800\nduplex-application-idle direction=windows-to-macos elapsedSeconds=28800\n'

test('duplex proof requires every ordered automatic recovery cycle after real idle', () => {
  const good = idleProof + [1, 2, 3].map(cycleProof).join('\n')
  assert.equal(workbenchDuplexRecoveryCycles(good, 3).length, 3)
  for (const bad of [
    [1, 2, 3].map(cycleProof).join('\n') + idleProof,
    idleProof + [1, 3].map(cycleProof).join('\n'),
    idleProof + [1, 1, 3].map(cycleProof).join('\n'),
    good.replace('forwardElapsedMs=1200', 'forwardElapsedMs=25001'),
    good.replaceAll('production-autoconnect-engine', 'manager-explicit'),
    good.replace(cycleProof(3), cycleProof(2).replace('cycle=2', 'cycle=3'))
  ])
    assert.throws(() => workbenchDuplexRecoveryCycles(bad, 3))
})
