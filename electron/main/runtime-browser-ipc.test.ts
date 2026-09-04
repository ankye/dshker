import { describe, expect, it } from 'vitest'
import { parseRuntimeBrowserZoomRequest } from './runtime-browser-ipc'

describe('runtime browser IPC payload', () => {
  it('admits one fixed zoom percentage', () => {
    expect(parseRuntimeBrowserZoomRequest({ zoomPercent: 125 })).toEqual({ zoomPercent: 125 })
  })

  it('rejects unknown fields, unsupported percentages, and non-record input', () => {
    expect(() => parseRuntimeBrowserZoomRequest({ zoomPercent: 100, other: true })).toThrow()
    expect(() => parseRuntimeBrowserZoomRequest({ zoomPercent: 120 })).toThrow()
    expect(() => parseRuntimeBrowserZoomRequest(100)).toThrow()
  })
})
