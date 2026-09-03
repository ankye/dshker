import { describe, expect, it } from 'vitest'
import { resolveExternalLink } from './external-links'

describe('external product links', () => {
  it('maps each allowed source identifier to its fixed HTTPS repository', () => {
    expect(resolveExternalLink('launcher-repository')).toBe('https://github.com/ankye/dshker')
    expect(resolveExternalLink('harness-repository')).toBe(
      'https://github.com/deepseek-ai/deepseek-harness'
    )
  })

  it('rejects a renderer-supplied URL or unknown identifier', () => {
    expect(() => resolveExternalLink('https://example.com')).toThrow('invalid')
    expect(() => resolveExternalLink('unknown')).toThrow('invalid')
  })
})
