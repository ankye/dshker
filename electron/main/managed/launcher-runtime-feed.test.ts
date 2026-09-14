import { describe, expect, it } from 'vitest'
import type { CoreHarnessLaunchView, CoreHarnessRuntimePort } from '../core/harness-runtime'
import { LauncherRuntimeFeed, consoleStreamOf } from './launcher-runtime-feed'

function runningView(): CoreHarnessLaunchView {
  return {
    launchId: 'launch-1',
    subjectId: 'launcher-harness',
    state: 'running',
    url: 'http://127.0.0.1:3088/?token=abc',
    pid: 4242,
    directory: '/launcher/versions/abc',
    port: { mode: 'auto' },
    diagnostics: {
      stdoutBytes: 1,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false
    }
  }
}

/** A port whose console pages and launch records the test drives directly. */
function fakeRuntime(): {
  readonly port: CoreHarnessRuntimePort
  readonly cursors: number[]
  page: {
    entries: { seq: number; stream: string; text: string; occurredAt: number }[]
    cursor: number
  }
  view: CoreHarnessLaunchView | undefined
} {
  const state = {
    cursors: [] as number[],
    page: { entries: [], cursor: 0 },
    view: runningView() as CoreHarnessLaunchView | undefined
  }
  const port: CoreHarnessRuntimePort = {
    async start() {
      return runningView()
    },
    async stop() {
      return { ...runningView(), state: 'stopped' as const }
    },
    async status() {
      return state.view
    },
    async console(cursor) {
      state.cursors.push(cursor)
      const page = state.page
      state.page = { entries: [], cursor: page.cursor }
      return page
    },
    async portGet() {
      return { mode: 'auto' as const }
    },
    async portSet(_path, port) {
      return port
    }
  }
  return Object.assign(state, { port })
}

describe('launcher runtime feed', () => {
  it('forwards console records and the launch record the core published', async () => {
    const runtime = fakeRuntime()
    runtime.page = {
      entries: [
        { seq: 1, stream: 'command', text: '$ dsh web --no-open\n', occurredAt: 10 },
        { seq: 2, stream: 'stdout', text: 'dsh web: http://127.0.0.1:3088/\n', occurredAt: 11 }
      ],
      cursor: 2
    }
    const forwarded: { stream: string; text: string }[] = []
    const views: CoreHarnessLaunchView[] = []
    const feed = new LauncherRuntimeFeed({
      runtime: async () => runtime.port,
      subjectId: 'launcher-harness',
      onConsole: (stream, text) => forwarded.push({ stream, text }),
      onLaunch: (view) => views.push(view)
    })

    await feed.drain()

    expect(forwarded).toEqual([
      { stream: 'command', text: '$ dsh web --no-open\n' },
      { stream: 'stdout', text: 'dsh web: http://127.0.0.1:3088/\n' }
    ])
    expect(views).toEqual([runningView()])
    // The next drain resumes from the cursor the core reported.
    await feed.drain()
    expect(runtime.cursors).toEqual([0, 2])
  })

  it('stops following a launch that has ended', async () => {
    const runtime = fakeRuntime()
    runtime.page = { entries: [], cursor: 4 }
    runtime.view = { ...runningView(), state: 'stopped' }
    const views: CoreHarnessLaunchView[] = []
    const feed = new LauncherRuntimeFeed({
      runtime: async () => runtime.port,
      subjectId: 'launcher-harness',
      onConsole: () => undefined,
      onLaunch: (view) => views.push(view)
    })

    await feed.drain()

    expect(views.map((view) => view.state)).toEqual(['stopped'])
  })

  it('treats a launch the core no longer knows as stopped rather than throwing', async () => {
    const runtime = fakeRuntime()
    runtime.view = undefined
    const views: CoreHarnessLaunchView[] = []
    const feed = new LauncherRuntimeFeed({
      runtime: async () => runtime.port,
      subjectId: 'launcher-harness',
      onConsole: () => undefined,
      onLaunch: (view) => views.push(view)
    })

    await expect(feed.drain()).resolves.toBeUndefined()
    expect(views).toEqual([])
  })

  it('swallows a core that cannot be reached, because a timer cannot report it', async () => {
    const feed = new LauncherRuntimeFeed({
      runtime: async () => {
        throw new Error('no core')
      },
      subjectId: 'launcher-harness',
      onConsole: () => undefined,
      onLaunch: () => undefined
    })

    await expect(feed.drain()).resolves.toBeUndefined()
  })

  it('narrows unknown core streams to standard output', () => {
    expect(consoleStreamOf('command')).toBe('command')
    expect(consoleStreamOf('stderr')).toBe('stderr')
    expect(consoleStreamOf('launcher')).toBe('launcher')
    expect(consoleStreamOf('something-else')).toBe('stdout')
  })
})
