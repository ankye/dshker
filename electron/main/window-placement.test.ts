import { describe, expect, it } from 'vitest'
import {
  isReachable,
  MIN_VISIBLE_HEIGHT,
  MIN_VISIBLE_WIDTH,
  placeInLayout,
  type Rect
} from './window-placement'

/**
 * Window placement across display changes.
 *
 * These are the layouts that actually broke: a monitor unplugged while the window
 * was on it, an external monitor to the left (which Windows expresses with negative
 * coordinates), and a window straddling the seam whose legal one-pixel overlap made
 * it "visible" while leaving nothing to grab.
 */

const laptop: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
const externalRight: Rect = { x: 1920, y: 0, width: 2560, height: 1400 }
const externalLeft: Rect = { x: -2560, y: 0, width: 2560, height: 1400 }

describe('window placement', () => {
  it('leaves a window that is fully on a display alone', () => {
    const window: Rect = { x: 200, y: 150, width: 1240, height: 820 }
    expect(placeInLayout(window, [laptop])).toEqual(window)
  })

  /**
   * The reported bug: the window was on the external monitor when it was unplugged,
   * so its coordinates name a desktop that no longer exists.
   */
  it('recovers a window stranded on an unplugged monitor to the right', () => {
    const stranded: Rect = { x: 2400, y: 300, width: 1240, height: 820 }
    expect(isReachable(stranded, [laptop, externalRight])).toBe(true)
    expect(isReachable(stranded, [laptop])).toBe(false)

    const placed = placeInLayout(stranded, [laptop])
    expect(isReachable(placed, [laptop])).toBe(true)
    // The whole window fits on the laptop display, so all of it is brought back.
    expect(placed.x).toBeGreaterThanOrEqual(laptop.x)
    expect(placed.y).toBeGreaterThanOrEqual(laptop.y)
    expect(placed.x + placed.width).toBeLessThanOrEqual(laptop.x + laptop.width)
    expect(placed.y + placed.height).toBeLessThanOrEqual(laptop.y + laptop.height)
    // Size is preserved: a display change is not a reason to resize the window.
    expect(placed.width).toBe(stranded.width)
    expect(placed.height).toBe(stranded.height)
  })

  /**
   * An external monitor placed to the left of the laptop gets negative coordinates.
   * Arithmetic that assumed the desktop starts at the origin would mishandle this.
   */
  it('recovers a window stranded on an unplugged monitor at negative coordinates', () => {
    const stranded: Rect = { x: -1800, y: 200, width: 1240, height: 820 }
    expect(isReachable(stranded, [externalLeft, laptop])).toBe(true)
    expect(isReachable(stranded, [laptop])).toBe(false)

    const placed = placeInLayout(stranded, [laptop])
    expect(isReachable(placed, [laptop])).toBe(true)
    expect(placed.x).toBeGreaterThanOrEqual(laptop.x)
  })

  /**
   * The silent case. A one-pixel column of the window still overlaps the laptop, so a
   * bare intersection test calls it visible — but 0.1% of the window is on screen and
   * the title bar is not grabbable. The user sees a window they cannot retrieve.
   */
  it('treats a one-pixel sliver as unreachable and brings the window back', () => {
    const sliver: Rect = { x: 1919, y: 500, width: 1240, height: 820 }
    expect(isReachable(sliver, [laptop])).toBe(false)

    const placed = placeInLayout(sliver, [laptop])
    expect(isReachable(placed, [laptop])).toBe(true)
    expect(placed.x + placed.width).toBeLessThanOrEqual(laptop.x + laptop.width)
  })

  it('accepts exactly the minimum grabbable strip and rejects one pixel less', () => {
    const exact: Rect = {
      x: laptop.width - MIN_VISIBLE_WIDTH,
      y: laptop.height - MIN_VISIBLE_HEIGHT,
      width: 1240,
      height: 820
    }
    expect(isReachable(exact, [laptop])).toBe(true)
    expect(isReachable({ ...exact, x: exact.x + 1 }, [laptop])).toBe(false)
    expect(isReachable({ ...exact, y: exact.y + 1 }, [laptop])).toBe(false)
  })

  /**
   * A window remembered from a larger monitor must not stay larger than the display
   * it lands on, or its own controls end up off-screen.
   */
  it('shrinks and centres a window larger than the display it must move to', () => {
    const oversized: Rect = { x: 2000, y: 100, width: 2400, height: 1300 }
    const placed = placeInLayout(oversized, [laptop])
    expect(placed.width).toBeLessThanOrEqual(laptop.width)
    expect(placed.height).toBeLessThanOrEqual(laptop.height)
    expect(isReachable(placed, [laptop])).toBe(true)
  })

  /**
   * With two displays still attached, a stranded window should land on the one it was
   * nearest, not always on the primary.
   */
  it('prefers the display the window most overlaps', () => {
    // Sitting just past the right edge of the right-hand monitor.
    const stranded: Rect = { x: 4400, y: 200, width: 1240, height: 820 }
    const placed = placeInLayout(stranded, [laptop, externalRight])
    expect(placed.x).toBeGreaterThanOrEqual(externalRight.x)
    expect(isReachable(placed, [laptop, externalRight])).toBe(true)
  })

  /**
   * A locked or headless session can report no displays. Inventing a position would
   * overwrite the placement the user wants back when a display returns.
   */
  it('leaves the window untouched when no display is reported', () => {
    const window: Rect = { x: 2400, y: 300, width: 1240, height: 820 }
    expect(placeInLayout(window, [])).toEqual(window)
  })

  it('is idempotent: placing an already placed window changes nothing', () => {
    const stranded: Rect = { x: 2400, y: 300, width: 1240, height: 820 }
    const once = placeInLayout(stranded, [laptop])
    expect(placeInLayout(once, [laptop])).toEqual(once)
  })
})
