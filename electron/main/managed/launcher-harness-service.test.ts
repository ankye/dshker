import { describe, expect, it } from 'vitest'
import { parseAnnouncedWebUrl, parseProfilePluginRecords } from './launcher-harness-service'

describe('parseAnnouncedWebUrl', () => {
  it('reads the exact URL DSH announced, preserving its session credential', () => {
    expect(parseAnnouncedWebUrl('dsh web: http://127.0.0.1:3080/?token=abc123\n')).toBe(
      'http://127.0.0.1:3080/?token=abc123'
    )
  })

  it('accepts the announcement on any line of a buffered chunk', () => {
    const chunk = 'building\ndsh web: http://127.0.0.1:41234/\nready\n'
    expect(parseAnnouncedWebUrl(chunk)).toBe('http://127.0.0.1:41234/')
  })

  it('keeps the port DSH chose rather than a launcher-assumed default', () => {
    expect(parseAnnouncedWebUrl('dsh web: http://127.0.0.1:59999/')).toContain(':59999')
  })

  it('ignores the LAN address printed after the loopback URL', () => {
    const line = 'dsh web: http://127.0.0.1:3080/ (LAN: http://192.168.1.4:3080/)'
    expect(parseAnnouncedWebUrl(line)).toBe('http://127.0.0.1:3080/')
  })

  it('rejects a non-loopback host so a log line cannot redirect the runtime view', () => {
    expect(parseAnnouncedWebUrl('dsh web: http://example.test:3080/')).toBeUndefined()
    expect(parseAnnouncedWebUrl('dsh web: http://192.168.1.4:3080/')).toBeUndefined()
  })

  it('rejects a non-http scheme', () => {
    expect(parseAnnouncedWebUrl('dsh web: file:///etc/passwd')).toBeUndefined()
    expect(parseAnnouncedWebUrl('dsh web: javascript:alert(1)')).toBeUndefined()
  })

  it('returns undefined for unrelated output and malformed announcements', () => {
    expect(parseAnnouncedWebUrl('')).toBeUndefined()
    expect(parseAnnouncedWebUrl('compiling packages...')).toBeUndefined()
    expect(parseAnnouncedWebUrl('dsh web:')).toBeUndefined()
    expect(parseAnnouncedWebUrl('dsh web: not-a-url')).toBeUndefined()
    // A quoted mention inside prose is not the launcher's own startup line.
    expect(parseAnnouncedWebUrl('see "dsh web: <url>" in the docs')).toBeUndefined()
  })
})

describe('parseProfilePluginRecords', () => {
  it('marks template bundles as default layers and dependencies as user plugins', () => {
    const manifest = {
      name: 'dsh-profile-web',
      dependencies: { 'dsh-pet': 'github:a/b' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-pet'] } }
    }
    expect(parseProfilePluginRecords(manifest)).toEqual([
      { name: 'dsh-pet', version: 'github:a/b', origin: 'user' },
      { name: '@deepseek-ai/dsh-base', version: '', origin: 'default' }
    ])
  })

  it('returns only template defaults when no dependency is installed', () => {
    const manifest = {
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
    }
    expect(parseProfilePluginRecords(manifest).map((plugin) => plugin.origin)).toEqual([
      'default',
      'default'
    ])
  })

  it('rejects malformed dependency and bundle records instead of guessing', () => {
    expect(() => parseProfilePluginRecords({ dependencies: ['nope'] })).toThrow()
    expect(() => parseProfilePluginRecords({ dsh: { profile: { bundles: [42] } } })).toThrow()
    expect(() => parseProfilePluginRecords('nope')).toThrow()
  })
})
