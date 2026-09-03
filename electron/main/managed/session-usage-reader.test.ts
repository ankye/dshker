import { describe, expect, it } from 'vitest'
import { decodeProjectDirectory, foldSessionLog } from './session-usage-reader'

/** Builds one session log line. */
function line(event: unknown): string {
  return JSON.stringify(event)
}

function usageChunk(turn: number, step: number, usage: Record<string, number>): string {
  return line({ type: 'assistant/chunk', data: { turn, step, chunk: { type: 'usage', usage } } })
}

function timedUsageChunk(
  turn: number,
  step: number,
  time: number,
  usage: Record<string, number>
): string {
  return line({
    type: 'assistant/chunk',
    time,
    data: { turn, step, chunk: { type: 'usage', usage } }
  })
}

describe('foldSessionLog', () => {
  it('reads session identity, model, and the first prompt', () => {
    const text = [
      line({ type: 'session', id: 'session-1', createdAt: 1_700_000_000_000 }),
      line({
        type: 'request/header',
        data: { header: { config: { provider: 'anthropic', model: 'claude-opus-5' } } }
      }),
      line({ type: 'user/message', data: { content: [{ type: 'text', text: '  hello  ' }] } })
    ].join('\n')

    const { folded } = foldSessionLog(text)
    expect(folded.sessionId).toBe('session-1')
    expect(folded.createdAt).toBe(1_700_000_000_000)
    expect(folded.model).toBe('claude-opus-5')
    expect(folded.provider).toBe('anthropic')
    expect(folded.firstPrompt).toBe('hello')
  })

  it('sums usage across distinct steps', () => {
    const text = [
      usageChunk(1, 1, { inputTokens: 100, outputTokens: 10 }),
      usageChunk(1, 2, { inputTokens: 200, outputTokens: 20 })
    ].join('\n')

    const { folded } = foldSessionLog(text)
    expect(folded.uncachedInputTokens).toBe(300)
    expect(folded.outputTokens).toBe(30)
  })

  it('replaces rather than adds a second report for the same step', () => {
    // A step reports usage twice: an early streaming chunk and the final
    // message. Summing both would double count that request.
    const text = [
      usageChunk(1, 1, { inputTokens: 0, outputTokens: 0 }),
      line({
        type: 'assistant/message',
        data: { turn: 1, step: 1, usage: { inputTokens: 500, outputTokens: 40 } }
      })
    ].join('\n')

    const { folded } = foldSessionLog(text)
    expect(folded.uncachedInputTokens).toBe(500)
    expect(folded.outputTokens).toBe(40)
  })

  it('ignores an identical repeated report', () => {
    const text = [
      usageChunk(1, 1, { inputTokens: 300, outputTokens: 30 }),
      usageChunk(1, 1, { inputTokens: 300, outputTokens: 30 })
    ].join('\n')

    expect(foldSessionLog(text).folded.uncachedInputTokens).toBe(300)
  })

  it('counts a retried attempt separately from the attempt it replaced', () => {
    const text = [
      usageChunk(1, 1, { inputTokens: 100, outputTokens: 5 }),
      line({ type: 'llm/retry-started', data: { turn: 1, step: 1 } }),
      usageChunk(1, 1, { inputTokens: 100, outputTokens: 5 })
    ].join('\n')

    // Both attempts were billed, so the total is the sum of the two.
    expect(foldSessionLog(text).folded.uncachedInputTokens).toBe(200)
  })

  it('keeps the three prompt-side buckets separate', () => {
    const text = usageChunk(1, 1, {
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 400,
      cacheWriteTokens: 20
    })

    const { folded } = foldSessionLog(text)
    expect(folded.uncachedInputTokens).toBe(10)
    expect(folded.cacheReadTokens).toBe(400)
    expect(folded.cacheWriteTokens).toBe(20)
  })

  it('groups timestamped usage by its local day and active model', () => {
    const day = new Date(2026, 8, 3, 10, 0, 0).getTime()
    const text = [
      line({
        type: 'request/header',
        data: { header: { config: { model: 'deepseek-v4' } } }
      }),
      timedUsageChunk(1, 1, day, { inputTokens: 100, outputTokens: 10 })
    ].join('\n')

    expect(foldSessionLog(text).dailyByModel).toEqual([
      {
        date: '2026-09-03',
        model: 'deepseek-v4',
        uncachedInputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      }
    ])
  })

  it('moves a replacement report out of its original daily model group', () => {
    const day = new Date(2026, 8, 3, 10, 0, 0).getTime()
    const text = [
      line({ type: 'request/header', data: { header: { config: { model: 'model-a' } } } }),
      timedUsageChunk(1, 1, day, { inputTokens: 10, outputTokens: 1 }),
      line({ type: 'request/header', data: { header: { config: { model: 'model-b' } } } }),
      line({
        type: 'assistant/message',
        time: day,
        data: { turn: 1, step: 1, usage: { inputTokens: 20, outputTokens: 2 } }
      })
    ].join('\n')

    expect(foldSessionLog(text).dailyByModel).toEqual([
      {
        date: '2026-09-03',
        model: 'model-b',
        uncachedInputTokens: 20,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      }
    ])
  })

  it('counts turns and steps', () => {
    const text = [
      line({ type: 'turn/start', data: { turn: 1 } }),
      line({ type: 'step/start', data: { turn: 1, step: 1 } }),
      line({ type: 'step/start', data: { turn: 1, step: 2 } }),
      line({ type: 'turn/start', data: { turn: 2 } }),
      line({ type: 'step/start', data: { turn: 2, step: 1 } })
    ].join('\n')

    const { folded } = foldSessionLog(text)
    expect(folded.turns).toBe(2)
    expect(folded.steps).toBe(3)
  })

  it('skips an unparsable line instead of failing the session', () => {
    const text = ['{ truncated', usageChunk(1, 1, { inputTokens: 70, outputTokens: 7 }), ''].join(
      '\n'
    )

    expect(foldSessionLog(text).folded.uncachedInputTokens).toBe(70)
  })

  it('ignores a negative or non-numeric count', () => {
    const text = usageChunk(1, 1, {
      inputTokens: -5,
      outputTokens: Number.NaN as unknown as number
    })

    const { folded } = foldSessionLog(text)
    expect(folded.uncachedInputTokens).toBe(0)
    expect(folded.outputTokens).toBe(0)
  })

  it('reports zeros for a session that never billed', () => {
    const { folded } = foldSessionLog(line({ type: 'session', id: 'session-empty', createdAt: 1 }))
    expect(folded.uncachedInputTokens).toBe(0)
    expect(folded.outputTokens).toBe(0)
    expect(folded.steps).toBe(0)
  })
})

describe('foldSessionLog resume', () => {
  it('continues an appended log without recounting the earlier part', () => {
    const first = foldSessionLog(usageChunk(1, 1, { inputTokens: 100, outputTokens: 10 }))
    const resumed = foldSessionLog(usageChunk(1, 2, { inputTokens: 50, outputTokens: 5 }), first)

    expect(resumed.folded.uncachedInputTokens).toBe(150)
    expect(resumed.folded.outputTokens).toBe(15)
  })

  it('carries the replacement slot across a resume boundary', () => {
    // The streaming chunk lands in one read and the final message in the next;
    // without the carried slot the step would be counted twice.
    const first = foldSessionLog(usageChunk(3, 7, { inputTokens: 0, outputTokens: 0 }))
    const resumed = foldSessionLog(
      line({
        type: 'assistant/message',
        data: { turn: 3, step: 7, usage: { inputTokens: 900, outputTokens: 80 } }
      }),
      first
    )

    expect(resumed.folded.uncachedInputTokens).toBe(900)
    expect(resumed.folded.outputTokens).toBe(80)
  })

  it('preserves identity discovered before the resume point', () => {
    const first = foldSessionLog(
      [
        line({ type: 'session', id: 'session-9', createdAt: 42 }),
        line({ type: 'user/message', data: { content: [{ type: 'text', text: 'first ask' }] } })
      ].join('\n')
    )
    const resumed = foldSessionLog(usageChunk(1, 1, { inputTokens: 10, outputTokens: 1 }), first)

    expect(resumed.folded.sessionId).toBe('session-9')
    expect(resumed.folded.createdAt).toBe(42)
    expect(resumed.folded.firstPrompt).toBe('first ask')
  })

  it('uses the most recent model header after an append resumes', () => {
    const day = new Date(2026, 8, 3, 10, 0, 0).getTime()
    const first = foldSessionLog(
      line({ type: 'request/header', data: { header: { config: { model: 'latest-model' } } } })
    )
    const resumed = foldSessionLog(timedUsageChunk(1, 1, day, { inputTokens: 10 }), first)

    expect(resumed.dailyByModel[0]?.model).toBe('latest-model')
  })
})

describe('decodeProjectDirectory', () => {
  it('restores a project path from DSH flattened directory name', () => {
    expect(decodeProjectDirectory('--fixtures-workspace--')).toBe('/fixtures/workspace')
  })

  it('returns the original name when it carries no path markers', () => {
    expect(decodeProjectDirectory('--')).toBe('--')
  })
})
