import { describe, expect, it } from 'vitest'
import type { LauncherHarnessConsoleEntry } from '@/shared/contracts'
import { consoleOutputParts } from '../consoleOutput'

const entry = (text: string, stream: LauncherHarnessConsoleEntry['stream'] = 'stderr') => ({
  text,
  stream,
  seq: 1,
  occurredAt: 1_700_000_000_000
})

describe('console severity presentation', () => {
  it.each([
    'Progress: resolved 100, reused 90, downloaded 10',
    'Receiving objects: 100% (20/20), done.',
    '2026-09-07 11:00:00 [I] hmr watching [] +2s',
    '2026-09-07T11:00:00.000Z [D] loading plugins',
    '[INFO] error handler installed',
    '[I] Error: is the prefix used for failures',
    '[W] web-server Error: read ECONNRESET',
    'INFO: no errors reported',
    'warning: deprecated dependency',
    'Found 0 errors.',
    'install error-handler complete',
    'dsh web: http://127.0.0.1:3088/',
    '\u001b[32m[I] listening\u001b[0m'
  ])('keeps normal stderr green: %s', (text) => {
    expect(consoleOutputParts(entry(text))).toEqual([{ text, severity: 'normal' }])
  })

  it.each([
    '[E] request failed',
    '2026-09-07 11:00:00 [E] request failed',
    '2026-09-07T11:00:00.123+08:00 [ERROR] request failed',
    '[FATAL] startup aborted',
    'ERROR request failed',
    'Error: read ECONNRESET',
    'TypeError: invalid input',
    'AggregateError: connection failed',
    'fatal: unable to access remote',
    'panic: operation failed',
    'npm ERR! code 1',
    'npm error code 1',
    'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL build failed',
    'ELIFECYCLE Command failed with exit code 1.',
    'EADDRINUSE',
    'src/main.ts(3,4): error TS2322: type mismatch',
    '\u001b[31m[E] request failed\u001b[0m'
  ])('marks explicit errors on either child stream: %s', (text) => {
    for (const stream of ['stdout', 'stderr'] as const) {
      expect(consoleOutputParts(entry(text, stream))).toEqual([{ text, severity: 'error' }])
    }
  })

  it.each([
    '[launcher] Switching DSH failed: fetch declined.',
    '[launcher] DSH Web child error: spawn denied',
    '[launcher] DSH Web process could not be created: denied',
    '[launcher] DSH Web process exited (code=1 signal=none).',
    '[launcher] DSH Web process exited (code=none signal=SIGKILL).'
  ])('marks Launcher failure diagnostics: %s', (text) => {
    expect(consoleOutputParts(entry(text, 'launcher'))[0].severity).toBe('error')
  })

  it.each([
    '[launcher] DSH Web announced its loopback URL; runtime is ready.',
    '[launcher] DSH Web process exited (code=0 signal=none).',
    '[launcher] DSH Web process exited (code=none signal=SIGTERM).',
    '[launcher] DSH Web process exited (code=none signal=SIGINT).'
  ])('keeps Launcher lifecycle and explicit stops normal: %s', (text) => {
    expect(consoleOutputParts(entry(text, 'launcher'))[0].severity).toBe('normal')
  })

  it('preserves raw multiline text and classifies errors independently', () => {
    const text = '[I] preparing\r\nError: broken\n    at run (main.js:1:2)\n[I] ready\rnext'
    const parts = consoleOutputParts(entry(text))
    expect(parts.map((part) => part.severity)).toEqual([
      'normal',
      'error',
      'error',
      'normal',
      'normal'
    ])
    expect(parts.map((part) => part.text).join('')).toBe(text)
  })

  it('does not treat a displayed command as a failure', () => {
    expect(consoleOutputParts(entry('ERROR=1 node main.js', 'command'))[0].severity).toBe('normal')
  })

  it('keeps empty output empty instead of manufacturing a line', () => {
    expect(consoleOutputParts(entry(''))).toEqual([])
    expect(
      consoleOutputParts(entry('\n\n'))
        .map((part) => part.text)
        .join('')
    ).toBe('\n\n')
  })
})
