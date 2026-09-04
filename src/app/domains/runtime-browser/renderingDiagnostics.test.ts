import { describe, expect, it } from 'vitest'
import {
  RUNTIME_GUEST_RENDERING_PROBE,
  parseRuntimeGuestRenderingInfo
} from './renderingDiagnostics'

const valid = {
  devicePixelRatio: 2,
  visualViewportScale: 1,
  colorScheme: 'dark',
  rootBackgroundColor: 'rgb(18, 24, 32)',
  bodyBackgroundColor: 'rgba(0, 0, 0, 0)',
  textColor: 'rgb(238, 242, 248)',
  fontFamily: 'Inter, sans-serif',
  fontSize: '14px',
  fontSmoothing: 'antialiased'
}

describe('runtime guest rendering diagnostics', () => {
  it('accepts the complete fixed diagnostic response', () => {
    expect(parseRuntimeGuestRenderingInfo(valid)).toEqual(valid)
  })

  it('rejects missing, unknown, and invalid fields', () => {
    expect(() => parseRuntimeGuestRenderingInfo({ ...valid, devicePixelRatio: 0 })).toThrow()
    expect(() => parseRuntimeGuestRenderingInfo({ ...valid, colorScheme: 'system' })).toThrow()
    const { fontSize: _fontSize, ...missing } = valid
    expect(() => parseRuntimeGuestRenderingInfo(missing)).toThrow()
    expect(() => parseRuntimeGuestRenderingInfo({ ...valid, location: 'secret' })).toThrow()
  })

  it('preserves unavailable viewport and body observations instead of guessing values', () => {
    expect(
      parseRuntimeGuestRenderingInfo({
        ...valid,
        visualViewportScale: null,
        bodyBackgroundColor: null,
        textColor: null,
        fontFamily: null,
        fontSize: null,
        fontSmoothing: null
      })
    ).toMatchObject({
      visualViewportScale: null,
      bodyBackgroundColor: null,
      textColor: null,
      fontFamily: null,
      fontSize: null,
      fontSmoothing: null
    })
    expect(RUNTIME_GUEST_RENDERING_PROBE).not.toContain('visualViewport === null ? 1')
  })

  it('never reads a guest address, cookies, storage, or document text', () => {
    expect(RUNTIME_GUEST_RENDERING_PROBE).not.toMatch(
      /location|cookie|localStorage|sessionStorage|innerText|textContent/u
    )
  })
})
