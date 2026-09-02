import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LauncherHarnessState } from '@/shared/contracts'
import { harnessState } from '@/app/domains/launcher-harness/useLauncherHarness'
import ControllerPanel from '../components/ControllerPanel.vue'

/**
 * The console is where a failed launch explains itself, so its log controls are
 * part of that diagnosis rather than decoration. These tests pin the parts that
 * were previously impossible: the log path was not shown at all, and the only
 * way to keep the output was to select hundreds of rows by hand.
 */
describe('ControllerPanel log controls', () => {
  const logFile = { path: '/tmp/dsh/logs/dsh-web.log', exists: true, byteLength: 2048 }

  /** Builds a ready state carrying the given console entries. */
  function readyState(
    entries: LauncherHarnessState['console'],
    file = logFile
  ): LauncherHarnessState {
    return {
      kind: 'ready',
      harnessDirectory: '/tmp/dsh/harness',
      remoteUrl: 'https://example.test/dsh.git',
      currentBranch: 'master',
      branches: ['master'],
      revision: 'a'.repeat(40),
      launch: { kind: 'stopped' },
      port: { mode: 'auto' },
      commits: [],
      stableVersions: [],
      plugins: [],
      console: entries,
      logFile: file
    }
  }

  afterEach(() => {
    harnessState.value = undefined
    vi.unstubAllGlobals()
  })

  it('shows the log path as copyable text so it can be pasted into a report', () => {
    harnessState.value = readyState([])
    const wrapper = mount(ControllerPanel)

    const path = wrapper.get('.controller-log-path')
    expect(path.text()).toBe(logFile.path)
    // Truncation is visual only; the full value must remain recoverable.
    expect(path.attributes('title')).toBe(logFile.path)
    expect(wrapper.find('.controller-log-bar .copy-path-button').exists()).toBe(true)
  })

  it('disables reveal and export before a launch has written the file', () => {
    harnessState.value = readyState([], { path: logFile.path, exists: false, byteLength: 0 })
    const wrapper = mount(ControllerPanel)

    const buttons = wrapper.findAll('.controller-log-actions button')
    // Reveal and export both act on a file that is not there yet.
    expect(buttons[0].attributes('disabled')).toBeDefined()
    expect(buttons[1].attributes('disabled')).toBeDefined()
    expect(wrapper.find('.controller-log-hint').exists()).toBe(true)
  })

  it('copies the whole output with timestamps and stream markers preserved', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    harnessState.value = readyState([
      { stream: 'stdout', occurredAt: 1_700_000_000_000, text: 'compiling\n' },
      { stream: 'stderr', occurredAt: 1_700_000_001_000, text: 'EADDRINUSE\n' }
    ])
    const wrapper = mount(ControllerPanel)

    const copyButton = wrapper.findAll('.controller-log-actions button')[2]
    await copyButton.trigger('click')

    const copied = writeText.mock.calls[0]?.[0] ?? ''
    expect(copied).toContain('stdout: compiling')
    expect(copied).toContain('stderr: EADDRINUSE')
    // A pasted excerpt is useless without knowing when each line arrived.
    expect(copied).toContain(new Date(1_700_000_000_000).toISOString())
  })

  it('cannot copy output that does not exist', () => {
    harnessState.value = readyState([])
    const wrapper = mount(ControllerPanel)

    const copyButton = wrapper.findAll('.controller-log-actions button')[2]
    expect(copyButton.attributes('disabled')).toBeDefined()
  })

  it('still offers the log path while the harness is not ready', () => {
    // The path matters most when nothing works, so it is not gated on readiness.
    harnessState.value = {
      kind: 'invalid',
      harnessDirectory: '/tmp/dsh/harness',
      message: 'broken',
      launch: { kind: 'stopped' },
      port: { mode: 'auto' },
      commits: [],
      stableVersions: [],
      plugins: [],
      console: [],
      logFile
    }
    const wrapper = mount(ControllerPanel)

    expect(wrapper.get('.controller-log-path').text()).toBe(logFile.path)
  })

  it('keeps a one-click launch action and exact runtime status at the Console bottom', () => {
    harnessState.value = readyState([])
    const wrapper = mount(ControllerPanel)

    const action = wrapper.get('.controller-bottom-action .prototype-button')
    expect(wrapper.get('.controller-runtime-status').text()).toBe('未启动')
    expect(action.text()).toBe('一键启动')
  })

  it('turns the Console action into stop when its managed child is running', () => {
    harnessState.value = {
      ...readyState([]),
      launch: { kind: 'running', url: 'http://127.0.0.1:3088/?token=launcher' }
    }
    const wrapper = mount(ControllerPanel)

    expect(wrapper.get('.controller-runtime-status').text()).toBe('运行中')
    expect(wrapper.get('.controller-bottom-action .prototype-button').text()).toBe('终止进程')
  })
})
