import { describe, expect, it } from 'vitest'
import type { LauncherHarnessConsoleEntry } from '@/shared/contracts'
import { computeOperationStepProgress, mergeConsoleEntries } from '../useLauncherHarness'

/**
 * The live console feed is fed by two asynchronous sources: push append events
 * and getState snapshots. Their arrival order is not guaranteed, so the merge
 * is what keeps the feed neither duplicating nor losing entries.
 */
describe('mergeConsoleEntries', () => {
  function entry(seq: number, text = `line ${seq}`): LauncherHarnessConsoleEntry {
    return { stream: 'launcher', occurredAt: seq, text, seq }
  }

  it('appends pushed entries after a snapshot in order', () => {
    const merged = mergeConsoleEntries([entry(1), entry(2)], [entry(3), entry(4)])

    expect(merged.map((item) => item.seq)).toEqual([1, 2, 3, 4])
  })

  it('does not lose pushed entries when an older snapshot arrives later', () => {
    // The getState reply raced the append events: its console ends at 2 while
    // the feed already holds 3 and 4. Replacing would roll the feed back.
    const merged = mergeConsoleEntries(
      [entry(1), entry(2), entry(3), entry(4)],
      [entry(1), entry(2)]
    )

    expect(merged.map((item) => item.seq)).toEqual([1, 2, 3, 4])
  })

  it('does not duplicate entries a snapshot already contains', () => {
    const merged = mergeConsoleEntries([entry(1), entry(2)], [entry(2), entry(3)])

    expect(merged.map((item) => item.seq)).toEqual([1, 2, 3])
  })

  it('keeps only the newest feed slice, mirroring the main-process cap', () => {
    const current = Array.from({ length: 999 }, (_unused, index) => entry(index + 1))
    const merged = mergeConsoleEntries(current, [entry(1_000), entry(1_001)])

    expect(merged).toHaveLength(1_000)
    expect(merged[0]?.seq).toBe(2)
    expect(merged[999]?.seq).toBe(1_001)
  })

  it('keeps the current feed unchanged for an empty snapshot', () => {
    const current = [entry(1)]

    expect(mergeConsoleEntries(current, [])).toBe(current)
  })
})

/**
 * Version operations report step-position progress so the statusbar can fill a
 * determinate bar — the one progress presentation that still moves when the OS
 * reduces motion and the indeterminate slide is neutralized.
 */
describe('computeOperationStepProgress', () => {
  function launcherEntry(text: string): LauncherHarnessConsoleEntry {
    return { stream: 'launcher', occurredAt: 0, text: `${text}\n`, seq: 0 }
  }

  it('counts a fetch step into update totals but not plain commit switches', () => {
    const updateEntries = [
      launcherEntry('Updating DSH to the newest origin/master commit…'),
      launcherEntry('Fetching DSH updates from origin (git fetch --prune --tags origin)…'),
      launcherEntry(
        'Fetching DSH updates from origin (git fetch --prune --tags origin) finished in 4s.'
      ),
      launcherEntry('Removing untracked build residue from the DSH checkout…')
    ]
    // A plain commit switch runs no fetch step at all.
    const switchEntries = [launcherEntry('Removing untracked build residue from the DSH checkout…')]

    const update = computeOperationStepProgress('update', updateEntries, 0, 42_000)
    const commitSwitch = computeOperationStepProgress('switch', switchEntries, 0, 42_000)

    expect(update).toEqual({ stepPosition: 2, totalSteps: 7, elapsedSeconds: 42 })
    expect(commitSwitch).toEqual({ stepPosition: 1, totalSteps: 6, elapsedSeconds: 42 })
  })

  it('caps the position at the total when every step has finished', () => {
    const finished = [
      // Seven completions imply the update ran its fetch step.
      launcherEntry('Fetching DSH updates from origin (git fetch --prune --tags origin)…'),
      ...Array.from({ length: 7 }, (_unused, index) =>
        launcherEntry(`Step ${String(index)} finished in 1s.`)
      )
    ]

    const progress = computeOperationStepProgress('update', finished, 0, 10_000)

    expect(progress?.stepPosition).toBe(7)
  })

  it('treats a version-list refresh as one step', () => {
    const progress = computeOperationStepProgress(
      'refresh',
      [launcherEntry('Fetching DSH updates from origin (git fetch --prune --tags origin)…')],
      1_000,
      5_000
    )

    expect(progress).toEqual({ stepPosition: 1, totalSteps: 1, elapsedSeconds: 4 })
  })

  it('reports no step progress for operations without a step pipeline', () => {
    expect(computeOperationStepProgress('installPlugin', [], 0, 1_000)).toBeUndefined()
    expect(computeOperationStepProgress('start', [], 0, 1_000)).toBeUndefined()
  })

  it('ignores child output and heartbeats; only completions advance the count', () => {
    const entries = [
      { stream: 'stdout' as const, occurredAt: 0, text: 'Receiving objects: 45%\n', seq: 0 },
      launcherEntry('Removing untracked build residue still running (300s elapsed)…')
    ]

    const progress = computeOperationStepProgress('switch', entries, 0, 300_000)

    expect(progress?.stepPosition).toBe(1)
    expect(progress?.elapsedSeconds).toBe(300)
  })
})
