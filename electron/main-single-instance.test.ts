import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The single-instance guard, asserted against the source.
 *
 * `main.ts` cannot be imported here: its module body acquires the instance lock and
 * registers real Electron handlers, so loading it would perform the very startup
 * this file reasons about. The three rules below are therefore checked as source
 * constraints — crude, but the alternative is no coverage at all, and each of these
 * has already cost real debugging time.
 */

const source = readFileSync(path.join(__dirname, 'main.ts'), 'utf8')

describe('single instance guard', () => {
  /**
   * Losing the lock must exit, not merely ask to.
   *
   * `app.quit()` requests a quit and returns, so control continued into
   * `await app.whenReady()` — a promise that never resolves for an app that is
   * already quitting. A second instance hung there, invisible, until the OS reaped
   * it: no window, no error, exit code 0.
   */
  it('exits immediately instead of falling through to whenReady', () => {
    const guard = source.slice(
      source.indexOf('requestSingleInstanceLock'),
      source.indexOf('const remoteDebuggingPort')
    )
    expect(guard).toContain('app.quit()')
    expect(guard).toContain('process.exit(0)')
  })

  /**
   * A smoke run points every root at a disposable directory, so it races nothing.
   * Making it contend for the lock meant the packaged-app release gate could not run
   * while a real Launcher was open — which is the normal state of a developer's
   * machine, and made a green build look broken.
   */
  it('exempts a smoke run from the lock', () => {
    expect(source).toMatch(/if \(!IS_SMOKE_TEST && !app\.requestSingleInstanceLock\(\)\)/)
  })

  /**
   * The exemption is only safe because smoke mode is decided before the guard runs.
   * If the flag were computed later, the guard would read `undefined` and every
   * smoke run would contend for the lock again.
   */
  it('decides smoke mode before the guard runs', () => {
    expect(source.indexOf('const IS_SMOKE_TEST')).toBeLessThan(
      source.indexOf('requestSingleInstanceLock')
    )
  })
})
