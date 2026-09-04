import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LauncherHarnessState } from '@/shared/contracts'
import { harnessConsole, harnessState } from '@/app/domains/launcher-harness/useLauncherHarness'
import ControllerPanel from '../components/ControllerPanel.vue'
import ControllerPrimaryAction from '../components/ControllerPrimaryAction.vue'

/**
 * The console is where a failed launch — or a failed update, switch, or plugin
 * install that never started DSH Web — explains itself. These tests pin the
 * parts that were previously impossible: the log path was not shown at all, the
 * only way to keep the output was to select hundreds of rows by hand, and a
 * not-ready harness hid the retained output behind an empty state.
 */
describe('ControllerPanel log controls', () => {
  const logFile = { path: '/tmp/dsh/logs/dsh-web.log', exists: true, byteLength: 2048 }

  /** Builds one console entry with the sequence the push feed merges by. */
  function entry(seq: number, stream: 'launcher' | 'stdout' | 'stderr', text: string) {
    return { stream, occurredAt: 1_700_000_000_000 + seq, text, seq }
  }

  /** Publishes one state and its console snapshot the way a state read would. */
  function seedState(next: LauncherHarnessState): void {
    harnessState.value = next
    harnessConsole.value = [...next.console]
  }

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
    harnessConsole.value = []
    vi.unstubAllGlobals()
  })

  it('shows the log path as copyable text so it can be pasted into a report', () => {
    seedState(readyState([]))
    const wrapper = mount(ControllerPanel)

    expect(wrapper.find('.controller-command').exists()).toBe(false)
    const path = wrapper.get('.controller-log-path')
    expect(path.text()).toBe(logFile.path)
    // Truncation is visual only; the full value must remain recoverable.
    expect(path.attributes('title')).toBe(logFile.path)
    expect(wrapper.find('.controller-log-bar .copy-path-button').exists()).toBe(true)
  })

  it('disables reveal and export before a launch has written the file', () => {
    seedState(readyState([], { path: logFile.path, exists: false, byteLength: 0 }))
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
    seedState(readyState([entry(1, 'stdout', 'compiling\n'), entry(2, 'stderr', 'EADDRINUSE\n')]))
    const wrapper = mount(ControllerPanel)

    const copyButton = wrapper.findAll('.controller-log-actions button')[2]
    await copyButton.trigger('click')

    const copied = writeText.mock.calls[0]?.[0] ?? ''
    expect(copied).toContain('stdout: compiling')
    expect(copied).toContain('stderr: EADDRINUSE')
    // A pasted excerpt is useless without knowing when each line arrived.
    expect(copied).toContain(new Date(1_700_000_000_002).toISOString())
  })

  it('copies the right-clicked log row without requiring a prior text selection', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    seedState(readyState([entry(1, 'launcher', 'child started\n')]))
    const wrapper = mount(ControllerPanel)

    await wrapper.get('.controller-output li').trigger('contextmenu', { clientX: 40, clientY: 60 })
    const copy = wrapper.get('.controller-copy-menu')
    expect(copy.text()).toBe('复制')
    await copy.trigger('click')

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('child started'))
    expect(wrapper.find('.controller-copy-menu').exists()).toBe(false)
  })

  it('cannot copy output that does not exist', () => {
    seedState(readyState([]))
    const wrapper = mount(ControllerPanel)

    const copyButton = wrapper.findAll('.controller-log-actions button')[2]
    expect(copyButton.attributes('disabled')).toBeDefined()
  })

  it('still offers the log path while the harness is not ready', () => {
    // The path matters most when nothing works, so it is not gated on readiness.
    seedState({
      kind: 'invalid',
      harnessDirectory: '/tmp/dsh/harness',
      message: 'broken',
      launch: { kind: 'stopped' },
      port: { mode: 'auto' },
      branches: [],
      revision: undefined,
      commits: [],
      stableVersions: [],
      plugins: [],
      console: [],
      logFile
    })
    const wrapper = mount(ControllerPanel)

    expect(wrapper.get('.controller-log-path').text()).toBe(logFile.path)
    // With nothing ever observed, the not-ready empty state stays honest.
    expect(wrapper.find('.controller-output').exists()).toBe(false)
    expect(wrapper.find('.empty-state').exists()).toBe(true)
  })

  it('shows retained operation output while the harness is invalid', () => {
    // A failed switch explains itself in the console; hiding it behind the
    // invalid-state empty state is how "nothing is displayed" used to happen.
    seedState({
      kind: 'invalid',
      harnessDirectory: '/tmp/dsh/harness',
      message: 'The Launcher Harness directory is missing its built DSH checkout.',
      launch: { kind: 'stopped' },
      port: { mode: 'auto' },
      branches: [],
      revision: undefined,
      commits: [],
      stableVersions: [],
      plugins: [],
      console: [
        entry(1, 'launcher', 'Switching DSH to commit a1b2c3…\n'),
        entry(2, 'launcher', 'Switching DSH to commit a1b2c3 failed: fetch declined.\n')
      ],
      logFile
    })
    const wrapper = mount(ControllerPanel)

    const rows = wrapper.findAll('.controller-output li')
    expect(rows).toHaveLength(2)
    expect(wrapper.find('.empty-state').exists()).toBe(false)
    // The readiness reason stays visible beside the output that explains it.
    const notice = wrapper.get('.controller-state-notice')
    expect(notice.text()).toContain('missing its built DSH checkout')
  })

  it('shows first-run preparation output while the harness is preparing', () => {
    seedState({
      kind: 'preparing',
      harnessDirectory: '/tmp/dsh/harness',
      message: 'The bundled DSH is being prepared.',
      launch: { kind: 'stopped' },
      port: { mode: 'auto' },
      branches: [],
      revision: undefined,
      commits: [],
      stableVersions: [],
      plugins: [],
      console: [
        entry(1, 'launcher', 'Installing DSH dependencies (pnpm install --frozen-lockfile).\n')
      ],
      logFile
    })
    const wrapper = mount(ControllerPanel)

    expect(wrapper.findAll('.controller-output li')).toHaveLength(1)
    expect(wrapper.get('.controller-state-notice').text()).toContain('being prepared')
  })

  it('uses the same primary action treatment as Launch at the Console bottom', () => {
    seedState(readyState([]))
    const wrapper = mount(ControllerPrimaryAction)

    const action = wrapper.get('.launch-primary-action')
    expect(wrapper.get('.controller-runtime-status').text()).toBe('未启动')
    expect(action.text()).toBe('一键启动')
  })

  it('turns the Console action into stop when its managed child is running', () => {
    seedState({
      ...readyState([]),
      launch: { kind: 'running', url: 'http://127.0.0.1:3088/?token=launcher' }
    })
    const wrapper = mount(ControllerPrimaryAction)

    expect(wrapper.get('.controller-runtime-status').text()).toBe('运行中')
    const action = wrapper.get('.launch-primary-action')
    expect(action.text()).toBe('终止进程')
    expect(action.attributes('data-running')).toBe('true')
  })
})
