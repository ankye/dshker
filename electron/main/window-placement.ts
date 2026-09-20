/**
 * Where the launcher window is allowed to sit.
 *
 * This is pure geometry on purpose: it takes display work areas as plain
 * rectangles and returns where the window belongs, so the placement rules can be
 * tested against real multi-monitor layouts — including negative coordinates and
 * hot-unplug — without constructing a BrowserWindow or mocking Electron's screen
 * module. `window.ts` supplies the live values and applies the answer.
 */

/** A rectangle in Windows/macOS virtual-desktop coordinates, which may be negative. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * How much of the window's draggable top edge must land on a real display.
 *
 * A bare intersection test is not enough. A window straddling the seam between two
 * monitors keeps a legal one-pixel overlap when the far monitor is unplugged, which
 * counts as "visible" while leaving nothing the user can actually grab — the title
 * bar is off-screen and the window cannot be dragged back. These two numbers are the
 * smallest strip that is genuinely grabbable.
 */
export const MIN_VISIBLE_WIDTH = 120
export const MIN_VISIBLE_HEIGHT = 32

/** The overlap between two rectangles, zero when they do not meet. */
function overlap(rect: Rect, area: Rect): { width: number; height: number } {
  const width = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x)
  const height = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y)
  return { width: Math.max(0, width), height: Math.max(0, height) }
}

/**
 * Whether enough of the window is reachable on at least one display.
 *
 * "Reachable" rather than "visible": the requirement is that the user can see and
 * grab it, which is why this measures the overlap instead of merely detecting one.
 */
export function isReachable(rect: Rect, workAreas: readonly Rect[]): boolean {
  return workAreas.some((area) => {
    const { width, height } = overlap(rect, area)
    return width >= MIN_VISIBLE_WIDTH && height >= MIN_VISIBLE_HEIGHT
  })
}

/**
 * Chooses the display a stranded window should move to.
 *
 * The one it overlaps most, so a window pulled off a removed monitor lands on the
 * neighbour it was closest to rather than always jumping to the primary display.
 * Falls back to the first work area when there is no overlap at all, which is the
 * ordinary case for a monitor that is simply gone.
 */
function bestHost(rect: Rect, workAreas: readonly Rect[]): Rect {
  let chosen = workAreas[0]
  let best = -1
  for (const area of workAreas) {
    const { width, height } = overlap(rect, area)
    const score = width * height
    if (score > best) {
      best = score
      chosen = area
    }
  }
  return chosen
}

/**
 * Places a window inside the current display layout.
 *
 * Returns the rectangle the window should occupy. A window that is already reachable
 * is returned unchanged, so this never disturbs a window the user has positioned.
 * Otherwise it is clamped onto the best host display — shrunk first if it is larger
 * than that display, then nudged inside — which is what a window returning from an
 * unplugged monitor needs. Centring is used only when the window has to shrink,
 * because a clamped window keeps the user's own placement as far as it can.
 *
 * With no displays at all (a locked or headless session reports none), the rectangle
 * is returned untouched: there is nowhere better to put it, and inventing a position
 * would overwrite the placement the user will want when a display comes back.
 */
export function placeInLayout(rect: Rect, workAreas: readonly Rect[]): Rect {
  if (workAreas.length === 0) return rect
  if (isReachable(rect, workAreas)) return rect
  const host = bestHost(rect, workAreas)
  const width = Math.min(rect.width, host.width)
  const height = Math.min(rect.height, host.height)
  // Clamp rather than centre, so a window that still fits keeps its relative spot.
  const x = Math.min(Math.max(rect.x, host.x), host.x + host.width - width)
  const y = Math.min(Math.max(rect.y, host.y), host.y + host.height - height)
  const shrank = width !== rect.width || height !== rect.height
  return shrank
    ? {
        x: Math.round(host.x + (host.width - width) / 2),
        y: Math.round(host.y + (host.height - height) / 2),
        width,
        height
      }
    : { x, y, width, height }
}
