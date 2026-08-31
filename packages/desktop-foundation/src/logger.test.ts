import { describe, expect, it } from 'vitest'
import { createDiagnostics, redactSecrets } from './logger'

describe('logger foundation', () => {
  it('redacts secret-like fields', () => {
    const redacted = redactSecrets({
      apiKey: 'sk-test-1234567890',
      nested: {
        token: 'abcdef1234567890'
      },
      safe: 'visible'
    })

    expect(redacted).toEqual({
      apiKey: '[redacted]',
      nested: {
        token: '[redacted]'
      },
      safe: 'visible'
    })
  })

  it('records structured diagnostics with timestamps and redacted context', async () => {
    const diagnostics = createDiagnostics({ clock: () => 1000, sink: () => undefined })

    await diagnostics.event({
      area: 'bridge',
      code: 'bridge.call_failed',
      level: 'warn',
      message: 'Bridge call failed.',
      context: { token: 'secret-token', channel: 'settings.load' }
    })

    expect(diagnostics.snapshot()).toEqual([
      {
        area: 'bridge',
        code: 'bridge.call_failed',
        level: 'warn',
        message: 'Bridge call failed.',
        timestampMs: 1000,
        context: { token: '[redacted]', channel: 'settings.load' }
      }
    ])
  })
})
