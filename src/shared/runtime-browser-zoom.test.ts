import { describe, expect, it } from 'vitest'
import {
  isRuntimeBrowserZoomPercent,
  nextRuntimeBrowserZoom,
  runtimeBrowserZoomCommandForInput,
  type RuntimeBrowserZoomInput
} from './runtime-browser-zoom'

function input(changes: Partial<RuntimeBrowserZoomInput> = {}): RuntimeBrowserZoomInput {
  return {
    type: 'keyDown',
    key: '=',
    code: 'Equal',
    isComposing: false,
    control: false,
    alt: false,
    meta: true,
    ...changes
  }
}

describe('runtime browser zoom', () => {
  it('uses the exact fixed steps and keeps their bounds', () => {
    expect(nextRuntimeBrowserZoom(100, 'increase')).toBe(110)
    expect(nextRuntimeBrowserZoom(100, 'decrease')).toBe(90)
    expect(nextRuntimeBrowserZoom(80, 'decrease')).toBe(80)
    expect(nextRuntimeBrowserZoom(200, 'increase')).toBe(200)
    expect(nextRuntimeBrowserZoom(150, 'reset')).toBe(100)
  })

  it('admits only product-defined percentages', () => {
    expect(isRuntimeBrowserZoomPercent(125)).toBe(true)
    expect(isRuntimeBrowserZoomPercent(120)).toBe(false)
    expect(isRuntimeBrowserZoomPercent('100')).toBe(false)
  })

  it('recognizes macOS browser shortcuts', () => {
    expect(runtimeBrowserZoomCommandForInput(input(), 'darwin')).toBe('increase')
    expect(runtimeBrowserZoomCommandForInput(input({ key: '-', code: 'Minus' }), 'darwin')).toBe(
      'decrease'
    )
    expect(runtimeBrowserZoomCommandForInput(input({ key: '0', code: 'Digit0' }), 'darwin')).toBe(
      'reset'
    )
  })

  it('recognizes Windows and Linux control shortcuts including keypad keys', () => {
    const controlInput = { meta: false, control: true }
    expect(runtimeBrowserZoomCommandForInput(input(controlInput), 'win32')).toBe('increase')
    expect(
      runtimeBrowserZoomCommandForInput(
        input({ ...controlInput, key: 'Add', code: 'NumpadAdd' }),
        'linux'
      )
    ).toBe('increase')
    expect(
      runtimeBrowserZoomCommandForInput(
        input({ ...controlInput, key: 'Subtract', code: 'NumpadSubtract' }),
        'linux'
      )
    ).toBe('decrease')
  })

  it('does not claim unrelated, composing, key-up, alt, or wrong-platform input', () => {
    expect(
      runtimeBrowserZoomCommandForInput(input({ key: 'p', code: 'KeyP' }), 'darwin')
    ).toBeUndefined()
    expect(
      runtimeBrowserZoomCommandForInput(input({ isComposing: true }), 'darwin')
    ).toBeUndefined()
    expect(runtimeBrowserZoomCommandForInput(input({ type: 'keyUp' }), 'darwin')).toBeUndefined()
    expect(runtimeBrowserZoomCommandForInput(input({ alt: true }), 'darwin')).toBeUndefined()
    expect(
      runtimeBrowserZoomCommandForInput(input({ meta: false, control: true }), 'darwin')
    ).toBeUndefined()
    expect(
      runtimeBrowserZoomCommandForInput(input({ meta: true, control: false }), 'win32')
    ).toBeUndefined()
  })
})
