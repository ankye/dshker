// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const controls = vi.hoisted(() => ({
  outputPath: '',
  onDestroy: () => undefined as unknown,
  beforeEvidenceWrite: async (_payload: string) => undefined as unknown,
  events: [] as string[]
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (args[0] !== controls.outputPath) return actual.writeFile(...args)
      controls.events.push('evidence-write-start')
      await controls.beforeEvidenceWrite(String(args[1]))
      await actual.writeFile(...args)
      controls.events.push('evidence-written')
    }
  }
})

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = { on: vi.fn() }
    destroy() {
      controls.events.push('window-destroyed')
      controls.onDestroy()
    }
  },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1008, height: 655 } }) }
}))

vi.mock('./security', () => ({ installWindowNavigationPolicy: vi.fn() }))
vi.mock('./window', () => ({ loadRenderer: vi.fn(async () => undefined) }))
vi.mock('./smoke-helpers', () => ({
  waitForRendererEvidence: vi.fn(async () => ({
    shellMounted: true,
    shellElement: true,
    rendererText: true,
    preload: true,
    errors: []
  })),
  smokeRoutes: vi.fn(async () => ({
    ok: true,
    routes: [{ id: 'launch', text: 'Launch', ok: true }]
  })),
  smokeHeightAdaptation: vi.fn(async () => ({ ok: true, cases: [] })),
  waitForRendererPaint: vi.fn(async () => undefined),
  captureFirstFrame: vi.fn(async () => ({})),
  analyzeFirstFrame: vi.fn(() => ({
    width: 1008,
    height: 655,
    nonblank: true,
    singleColor: false,
    sampledPixels: 100,
    variedPixels: 80,
    contentPixels: 100
  })),
  withRendererDeadline: vi.fn(async (work: Promise<unknown>) => work)
}))

import { waitForRendererEvidence } from './smoke-helpers'
import { runSmokeTest, writeSmokeFailure } from './smoke'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

/** Execute the actual entry's two lifecycle blocks without starting its services. */
async function entryLifecycle() {
  const source = await readFile(new URL('../main.ts', import.meta.url), 'utf8')
  const file = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
  const dispatch = file.statements.find(
    (statement) =>
      ts.isIfStatement(statement) && statement.expression.getText(file) === 'IS_SMOKE_TEST'
  )
  const windowsClosed = file.statements.find((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
      return false
    const call = statement.expression
    return (
      call.expression.getText(file) === 'app.on' &&
      ts.isStringLiteral(call.arguments[0]!) &&
      call.arguments[0].text === 'window-all-closed'
    )
  })
  if (!dispatch || !windowsClosed) throw new Error('Launcher lifecycle entry blocks are missing')
  if (!ts.isIfStatement(dispatch) || !ts.isBlock(dispatch.thenStatement))
    throw new Error('Launcher smoke dispatch is not a block')
  // Observe the entry's otherwise void promise without changing its exit callbacks.
  const observedDispatch = ts.factory.updateIfStatement(
    dispatch,
    dispatch.expression,
    ts.factory.updateBlock(
      dispatch.thenStatement,
      dispatch.thenStatement.statements.map((statement) =>
        ts.isExpressionStatement(statement) && ts.isVoidExpression(statement.expression)
          ? ts.factory.createExpressionStatement(
              ts.factory.createAssignment(
                ts.factory.createIdentifier('smokeCompletion'),
                statement.expression.expression
              )
            )
          : statement
      )
    ),
    dispatch.elseStatement
  )
  const dispatchSource = ts
    .createPrinter()
    .printNode(ts.EmitHint.Unspecified, observedDispatch, file)
  const compiled = ts.transpileModule(
    `let smokeCompletion;\n${dispatchSource}\n${windowsClosed.getText(file)}`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
    }
  )
  return new Function(
    'IS_SMOKE_TEST',
    'app',
    'process',
    'isTrayActive',
    'startSmokeTest',
    'start',
    'writeSmokeFailure',
    'console',
    `${compiled.outputText}\nreturn smokeCompletion;`
  )
}

const directories: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fixture(
  smoke: boolean,
  platform = 'win32',
  trayActive = false,
  configureOutput?: (outputPath: string) => Promise<void>
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dshker-smoke-lifecycle-'))
  directories.push(directory)
  controls.outputPath = path.join(directory, 'packaged-launch.json')
  controls.events = []
  controls.beforeEvidenceWrite = async () => undefined
  await configureOutput?.(controls.outputPath)
  vi.stubEnv('DESKTOP_APP_SMOKE_OUTPUT', controls.outputPath)
  vi.stubEnv('DESKTOP_APP_SMOKE_SHOTS', '')
  const exited = deferred<number>()
  const app = Object.assign(new EventEmitter(), {
    quit: vi.fn(() => controls.events.push('app-quit')),
    exit: vi.fn((code: number) => {
      controls.events.push(`app-exit:${code}`)
      exited.resolve(code)
    })
  })
  controls.onDestroy = () => app.emit('window-all-closed')
  const launch = await entryLifecycle()
  const reportError = vi.fn()
  const completion = launch(
    smoke,
    app,
    { platform },
    () => trayActive,
    () => runSmokeTest(directory),
    () => new Promise(() => undefined),
    writeSmokeFailure,
    { error: reportError }
  ) as Promise<void> | undefined
  return { app, exited: exited.promise, completion, reportError }
}

describe('packaged smoke exit ownership', () => {
  it.each(['win32', 'darwin'])(
    'waits for success evidence before exiting on %s',
    async (platform) => {
      const started = deferred<void>()
      const release = deferred<void>()
      const f = await fixture(true, platform)
      controls.beforeEvidenceWrite = async () => {
        started.resolve()
        await release.promise
      }
      await started.promise
      const quitBeforeWrite = f.app.quit.mock.calls.length
      const exitBeforeWrite = f.app.exit.mock.calls.length
      release.resolve()
      expect(await f.exited).toBe(0)
      expect(quitBeforeWrite).toBe(0)
      expect(exitBeforeWrite).toBe(0)
      expect(f.app.quit).not.toHaveBeenCalled()
      expect(controls.events).toEqual([
        'window-destroyed',
        'evidence-write-start',
        'evidence-written',
        'app-exit:0'
      ])
      expect(JSON.parse(await readFile(controls.outputPath, 'utf8')).ok).toBe(true)
    }
  )

  it('writes renderer failure diagnostics after destroy before exiting', async () => {
    vi.mocked(waitForRendererEvidence).mockRejectedValueOnce(new Error('renderer probe failed'))
    const started = deferred<void>()
    const release = deferred<void>()
    const f = await fixture(true)
    controls.beforeEvidenceWrite = async () => {
      started.resolve()
      await release.promise
    }
    await started.promise
    const quitBeforeWrite = f.app.quit.mock.calls.length
    const exitBeforeWrite = f.app.exit.mock.calls.length
    release.resolve()
    expect(await f.exited).toBe(1)
    expect(quitBeforeWrite).toBe(0)
    expect(exitBeforeWrite).toBe(0)
    expect(f.app.quit).not.toHaveBeenCalled()
    expect(controls.events).toEqual([
      'window-destroyed',
      'evidence-write-start',
      'evidence-written',
      'app-exit:1'
    ])
    expect(JSON.parse(await readFile(controls.outputPath, 'utf8'))).toMatchObject({
      ok: false,
      error: { message: 'renderer probe failed' }
    })
  })

  it('records a failed success-payload write before the failure exit', async () => {
    const f = await fixture(true)
    controls.beforeEvidenceWrite = async (payload) => {
      if (JSON.parse(payload).ok === true) throw new Error('success evidence write failed')
    }
    expect(await f.exited).toBe(1)
    expect(f.app.quit).not.toHaveBeenCalled()
    expect(controls.events).toEqual([
      'window-destroyed',
      'evidence-write-start',
      'evidence-write-start',
      'evidence-written',
      'app-exit:1'
    ])
    expect(JSON.parse(await readFile(controls.outputPath, 'utf8'))).toMatchObject({
      ok: false,
      error: { message: 'success evidence write failed' }
    })
  })

  it('exits with failure when neither success nor failure payload can be written', async () => {
    const f = await fixture(true, 'win32', false, async (outputPath) => {
      await mkdir(outputPath)
    })
    await f.completion
    expect(f.app.quit).not.toHaveBeenCalled()
    expect(f.app.exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(controls.events).toEqual([
      'window-destroyed',
      'evidence-write-start',
      'evidence-write-start',
      'app-exit:1'
    ])
    expect(f.reportError.mock.calls.map(([message]) => message)).toEqual([
      'DSHKer Launcher smoke test failed.',
      'DSHKer Launcher could not write smoke failure diagnostics.'
    ])
    for (const [, error] of f.reportError.mock.calls) {
      expect(error).toMatchObject({ path: controls.outputPath, syscall: 'open' })
      expect(error.code).toMatch(/^(EISDIR|EPERM|EACCES)$/)
    }
  })

  it('exits with failure when both smoke and failure tracing are unwritable', async () => {
    const f = await fixture(true, 'win32', false, async (outputPath) => {
      await mkdir(`${outputPath}.trace`)
    })
    await f.completion
    expect(f.app.quit).not.toHaveBeenCalled()
    expect(f.app.exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(controls.events).toEqual(['app-exit:1'])
    expect(f.reportError.mock.calls.map(([message]) => message)).toEqual([
      'DSHKer Launcher smoke test failed.',
      'DSHKer Launcher could not write smoke failure diagnostics.'
    ])
    for (const [, error] of f.reportError.mock.calls) {
      expect(error).toMatchObject({ path: `${controls.outputPath}.trace`, syscall: 'open' })
      expect(error.code).toMatch(/^(EISDIR|EPERM|EACCES)$/)
    }
  })

  it.each([
    ['win32', false, 1],
    ['linux', false, 1],
    ['darwin', false, 0],
    ['win32', true, 0]
  ] as const)(
    'preserves normal close behavior on %s with tray=%s',
    async (platform, tray, quits) => {
      const f = await fixture(false, platform, tray)
      f.app.emit('window-all-closed')
      expect(f.app.quit).toHaveBeenCalledTimes(quits)
      expect(f.app.exit).not.toHaveBeenCalled()
    }
  )
})
