import { BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_METADATA } from '../../src/shared/contracts'
import { createPreloadWebPreferences } from './preload'
import { installWindowNavigationPolicy } from './security'
import { loadRenderer } from './window'
import {
  analyzeFirstFrame,
  captureFirstFrame,
  smokeHeightAdaptation,
  smokeRoutes,
  waitForRendererEvidence,
  waitForRendererPaint,
  type FrameEvidence,
  type HeightAdaptationEvidence,
  type RendererEvidence,
  type RouteSmokeEvidence
} from './smoke-helpers'

function smokeOutputPath(): string | undefined {
  return process.env.DESKTOP_APP_SMOKE_OUTPUT ?? process.env.ELECTRON_SMOKE_OUTPUT
}

/**
 * Writes one screenshot per route when DESKTOP_APP_SMOKE_SHOTS names a directory.
 * Screenshots are evidence for design review, so a capture failure must not turn
 * a passing functional smoke into a red gate.
 */
async function captureRouteScreenshots(
  smokeWindow: BrowserWindow,
  routeIds: readonly string[]
): Promise<void> {
  const directory = process.env.DESKTOP_APP_SMOKE_SHOTS
  if (!directory) return
  await mkdir(directory, { recursive: true })
  for (const route of routeIds) {
    try {
      await smokeWindow.webContents.executeJavaScript(
        `(() => {
          const control = document.querySelector('[data-testid="nav-' + ${JSON.stringify(route)} + '"]');
          if (control) control.click();
          return true;
        })()`
      )
      await waitForRendererPaint(smokeWindow)
      const image = await smokeWindow.webContents.capturePage()
      await writeFile(join(directory, `${route}.png`), image.toPNG())

      // A route taller than the stage keeps its lower controls out of the first
      // frame, so a scrolled capture is recorded whenever one exists.
      const scrolled = await smokeWindow.webContents.executeJavaScript(
        `(() => {
          const stage = document.querySelector('.workbench-stage');
          if (!stage || stage.scrollHeight <= stage.clientHeight + 8) return false;
          stage.scrollTop = stage.scrollHeight;
          return true;
        })()`
      )
      if (scrolled === true) {
        await waitForRendererPaint(smokeWindow)
        const tail = await smokeWindow.webContents.capturePage()
        await writeFile(join(directory, `${route}-scrolled.png`), tail.toPNG())
      }
    } catch {
      // Recorded by absence of the file; the functional checks stay authoritative.
    }
  }
}

/**
 * Proves a packaged build actually renders: it loads the real renderer through
 * the same isolation posture as the product window, walks every shell route,
 * and samples the first painted frame.
 *
 * The window is positioned offscreen rather than hidden, because a hidden
 * window may never paint and would make the frame evidence meaningless.
 */
export async function runSmokeTest(mainDirectory: string): Promise<void> {
  const smokeWindow = new BrowserWindow({
    x: -10000,
    y: -10000,
    width: 1240,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: `${APP_METADATA.name} Smoke`,
    backgroundColor: '#121820',
    show: true,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: createPreloadWebPreferences(mainDirectory)
  })
  installWindowNavigationPolicy(smokeWindow.webContents)

  let rendererEvidence: RendererEvidence = {
    shellMounted: false,
    shellElement: false,
    rendererText: false,
    preload: false,
    errors: []
  }
  let firstFrame: FrameEvidence = {
    width: 0,
    height: 0,
    nonblank: false,
    singleColor: true,
    sampledPixels: 0,
    variedPixels: 0,
    contentPixels: 0
  }
  let routeEvidence: RouteSmokeEvidence = { ok: false, routes: [] }
  let heightEvidence: HeightAdaptationEvidence = { ok: false, cases: [] }

  try {
    await loadRenderer(smokeWindow)
    rendererEvidence = await waitForRendererEvidence(smokeWindow)
    routeEvidence = await smokeRoutes(smokeWindow)
    heightEvidence = await smokeHeightAdaptation(
      smokeWindow,
      routeEvidence.routes.map((entry) => entry.id)
    )
    await waitForRendererPaint(smokeWindow)
    firstFrame = analyzeFirstFrame(await captureFirstFrame(smokeWindow))
    // Opt-in visual evidence. The packaged smoke is the only path that renders
    // with the real preload and custom protocol, so design review reads its
    // screenshots rather than a separately launched window.
    await captureRouteScreenshots(
      smokeWindow,
      routeEvidence.routes.map((entry) => entry.id)
    )
  } finally {
    smokeWindow.destroy()
  }

  const appIdentity = Boolean(APP_METADATA.bundleId && APP_METADATA.version)
  const payload = {
    app: {
      // The release manifest records the installed bundle identity, so the
      // evidence reports `bundleId` rather than the internal short `appId`.
      appId: APP_METADATA.bundleId,
      name: APP_METADATA.name,
      version: APP_METADATA.version
    },
    ok:
      appIdentity &&
      rendererEvidence.shellMounted &&
      rendererEvidence.shellElement &&
      rendererEvidence.rendererText &&
      rendererEvidence.preload &&
      routeEvidence.ok &&
      heightEvidence.ok &&
      firstFrame.nonblank &&
      !firstFrame.singleColor &&
      rendererEvidence.errors.length === 0,
    checks: {
      appIdentity,
      routeSmoke: routeEvidence.ok,
      heightAdaptation: heightEvidence.ok,
      rendererShellMounted: rendererEvidence.shellMounted,
      rendererShellElement: rendererEvidence.shellElement,
      rendererText: rendererEvidence.rendererText,
      preload: rendererEvidence.preload,
      firstFrameNonblank: firstFrame.nonblank,
      firstFrameNotSingleColor: !firstFrame.singleColor,
      rendererErrors: rendererEvidence.errors.length === 0
    },
    routeEvidence,
    heightEvidence,
    rendererEvidence,
    firstFrame
  }

  const outputPath = smokeOutputPath()
  if (outputPath) await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(payload))
  if (!payload.ok) throw new Error('renderer smoke evidence failed')
}

/** Records a smoke failure so the harness reports the cause, not just an exit code. */
export async function writeSmokeFailure(error: unknown): Promise<void> {
  const outputPath = smokeOutputPath()
  if (!outputPath) return

  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        }
      },
      null,
      2
    )}\n`,
    'utf8'
  )
}
