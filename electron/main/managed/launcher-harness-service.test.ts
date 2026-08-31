import { describe, expect, it } from 'vitest'
import { parseAnnouncedWebUrl } from './launcher-harness-service'

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
