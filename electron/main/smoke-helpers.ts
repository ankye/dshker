import type { BrowserWindow as ElectronBrowserWindow, NativeImage } from 'electron'

/** Renderer facts a packaged launch must prove before it counts as working. */
export interface RendererEvidence {
  shellMounted: boolean
  shellElement: boolean
  rendererText: boolean
  preload: boolean
  errors: string[]
}

/** Per-route reachability evidence for the shell's navigation. */
export interface RouteSmokeEvidence {
  ok: boolean
  routes: Array<{ id: string; text: string; ok: boolean }>
}

/** First-frame pixel evidence proving the window painted real content. */
export interface FrameEvidence {
  width: number
  height: number
  nonblank: boolean
  singleColor: boolean
  sampledPixels: number
  variedPixels: number
  contentPixels: number
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * Polls the renderer until the shell reports itself mounted with the trusted
 * preload bridge present, collecting console and crash errors throughout.
 */
export async function waitForRendererEvidence(
  window: ElectronBrowserWindow
): Promise<RendererEvidence> {
  const errors: string[] = []
  window.webContents.on('render-process-gone', (_event, details) => {
    errors.push(`render-process-gone:${details.reason}`)
  })
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message)
  })

  const deadline = Date.now() + 8000
  let evidence: RendererEvidence = {
    shellMounted: false,
    shellElement: false,
    rendererText: false,
    preload: false,
    errors
  }

  while (Date.now() < deadline) {
    try {
      evidence = await window.webContents.executeJavaScript(
        `(() => ({
          shellMounted: document.documentElement.dataset.appShellMounted === 'true',
          shellElement: Boolean(document.querySelector('.app-shell')),
          rendererText: document.body?.innerText?.includes('DSHKer Launcher') === true,
          preload: typeof window.dshLauncher === 'object' && window.dshLauncher !== null,
          errors: []
        }))()`
      )
      evidence.errors = errors
      if (
        evidence.shellMounted &&
        evidence.shellElement &&
        evidence.rendererText &&
        evidence.preload
      ) {
        return evidence
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
    await delay(100)
  }

  return evidence
}

/**
 * Visits every shell route by clicking its navigation control.
 *
 * The Launcher shell keeps route state in memory and exposes no URL route, so a
 * hash-based walk would silently pass without changing the view.
 */
export async function smokeRoutes(window: ElectronBrowserWindow): Promise<RouteSmokeEvidence> {
  const cases: readonly { id: string; text: string; selector: string }[] = [
    { id: 'launch', text: 'Launch', selector: '.launch-panel' },
    { id: 'controller', text: 'Console', selector: '.controller-panel' },
    { id: 'versions', text: 'Versions', selector: '.version-management' },
    { id: 'usage', text: 'Token usage', selector: '.usage-panel' },
    { id: 'settings', text: 'Settings', selector: '.settings-panel' },
    { id: 'runtime', text: 'Run', selector: '.browser-panel' }
  ]
  const routes: RouteSmokeEvidence['routes'] = []

  for (const route of cases) {
    const ok = await window.webContents.executeJavaScript(
      `new Promise((resolve) => {
        const control = document.querySelector('[data-testid="nav-' + ${JSON.stringify(route.id)} + '"]');
        if (!control) {
          resolve(false);
          return;
        }
        control.click();
        setTimeout(() => {
          const active = control.dataset.active === 'true';
          const shown = document.querySelector(${JSON.stringify(route.selector)}) !== null;
          resolve(active && shown);
        }, 160);
      })`
    )
    routes.push({ ...route, ok: Boolean(ok) })
  }

  return {
    ok: routes.every((route) => route.ok),
    routes
  }
}

/** Samples the captured frame to distinguish real content from a blank fill. */
export function analyzeFirstFrame(image: NativeImage): FrameEvidence {
  const size = image.getSize()
  const bitmap = image.toBitmap()
  const stepX = Math.max(1, Math.floor(size.width / 48))
  const stepY = Math.max(1, Math.floor(size.height / 48))
  let sampledPixels = 0
  let variedPixels = 0
  let contentPixels = 0
  let firstColor = ''

  for (let y = 0; y < size.height; y += stepY) {
    for (let x = 0; x < size.width; x += stepX) {
      const offset = (y * size.width + x) * 4
      const blue = bitmap[offset] ?? 0
      const green = bitmap[offset + 1] ?? 0
      const red = bitmap[offset + 2] ?? 0
      const alpha = bitmap[offset + 3] ?? 0
      const color = `${String(red)},${String(green)},${String(blue)},${String(alpha)}`
      const brightness = (red + green + blue) / 3

      if (!firstColor) firstColor = color
      if (color !== firstColor) variedPixels += 1
      if (alpha > 0 && brightness > 8 && brightness < 247) contentPixels += 1
      sampledPixels += 1
    }
  }

  return {
    width: size.width,
    height: size.height,
    nonblank: contentPixels / Math.max(sampledPixels, 1) > 0.08,
    singleColor: variedPixels / Math.max(sampledPixels, 1) < 0.02,
    sampledPixels,
    variedPixels,
    contentPixels
  }
}

export async function captureFirstFrame(window: ElectronBrowserWindow): Promise<NativeImage> {
  let lastError: unknown
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const image = await window.webContents.capturePage()
      if (!image.isEmpty()) return image
    } catch (error) {
      lastError = error
    }
    await delay(150)
  }
  throw lastError instanceof Error ? lastError : new Error('Unable to capture first frame')
}

export async function waitForRendererPaint(window: ElectronBrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
  )
  await delay(250)
}

/** Per-route proof that a given window size keeps chrome visible and content reachable. */
export interface HeightAdaptationEvidence {
  ok: boolean
  cases: Array<{
    height: number
    route: string
    chromeVisible: boolean
    contentReachable: boolean
    documentStatic: boolean
  }>
}

/**
 * Resizes the window to short heights and checks every route still works.
 *
 * A stylesheet assertion cannot prove this: only a real layout pass shows
 * whether the topbar and statusbar survive a short window and whether overflow
 * scrolls inside the stage instead of stretching the document.
 */
export async function smokeHeightAdaptation(
  window: ElectronBrowserWindow,
  routeIds: readonly string[]
): Promise<HeightAdaptationEvidence> {
  const cases: HeightAdaptationEvidence['cases'] = []
  // Resize the content area rather than the native frame. Cocoa's frame
  // constraints can destroy an x64 smoke window when a title-bar-inclusive
  // size falls below the runner's available work area.
  const [initialWidth, initialHeight] = window.getContentSize()

  // Never request a content height larger than the runner can currently
  // display. On Intel macOS CI the work area can be shorter than 820px;
  // asking Cocoa to grow beyond it destroys the smoke window instead of
  // exercising the renderer layout.
  const heights = [
    ...new Set([initialHeight, 560, 420].map((height) => Math.min(height, initialHeight)))
  ]

  for (const height of heights) {
    if (window.isDestroyed()) throw new Error(`Smoke window was destroyed before height ${height}.`)
    window.setContentSize(initialWidth, height)
    await delay(220)
    for (const route of routeIds) {
      if (window.isDestroyed()) {
        throw new Error(`Smoke window was destroyed at height ${height}, route ${route}.`)
      }
      const probe = await window.webContents.executeJavaScript(
        `new Promise((resolve) => {
          const control = document.querySelector('[data-testid="nav-' + ${JSON.stringify(route)} + '"]');
          if (control) control.click();
          setTimeout(() => {
            const doc = document.documentElement;
            const shell = document.querySelector('.app-shell');
            const stage = document.querySelector('.workbench-stage');
            const rows = document.querySelectorAll('.app-shell > *');
            // Chrome is whatever the shell puts in its first and last rows. This
            // app moved its identity into the sidebar and has no '.topbar', so
            // asserting that specific element would fail a shell that is correct.
            const first = rows[0];
            const last = rows[rows.length - 1];
            const viewport = window.innerHeight;
            const top = first && first.getBoundingClientRect();
            const bottom = last && last.getBoundingClientRect();
            let reachable = true;
            if (stage && stage.scrollHeight > stage.clientHeight + 1) {
              stage.scrollTop = stage.scrollHeight;
              reachable = stage.scrollTop > 0;
              stage.scrollTop = 0;
            }
            resolve({
              chromeVisible: Boolean(
                top && bottom &&
                top.top >= -1 && top.bottom <= viewport + 1 &&
                bottom.bottom <= viewport + 1
              ),
              contentReachable: reachable,
              documentStatic:
                doc.scrollHeight <= doc.clientHeight + 1 &&
                Boolean(shell) &&
                shell.getBoundingClientRect().height <= viewport + 1
            });
          }, 170);
        })`
      )
      cases.push({ height, route, ...probe })
    }
  }

  if (window.isDestroyed()) throw new Error('Smoke window was destroyed before size restore.')
  window.setContentSize(initialWidth, initialHeight)
  await delay(200)
  return {
    ok: cases.every(
      (entry) => entry.chromeVisible && entry.contentReachable && entry.documentStatic
    ),
    cases
  }
}
