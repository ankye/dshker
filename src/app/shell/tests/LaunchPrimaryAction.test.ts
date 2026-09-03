import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { LauncherHarnessState } from '@/shared/contracts'
import { harnessState } from '@/app/domains/launcher-harness/useLauncherHarness'
import LaunchPrimaryAction from '../components/LaunchPrimaryAction.vue'

/** The start control remains the ownership point for stopping a Launcher child. */
describe('LaunchPrimaryAction', () => {
  afterEach(() => {
    harnessState.value = undefined
  })

  it('turns into an enabled stop action while DSH Web is running', () => {
    harnessState.value = {
      kind: 'ready',
      harnessDirectory: '/tmp/dsh/harness',
      remoteUrl: 'https://example.test/dsh.git',
      currentBranch: 'master',
      branches: ['master'],
      revision: 'a'.repeat(40),
      launch: { kind: 'running', url: 'http://127.0.0.1:3088/?token=launcher' },
      port: { mode: 'auto' },
      commits: [],
      stableVersions: [],
      plugins: [],
      console: [],
      logFile: { path: '/tmp/dsh/logs/dsh-web.log', exists: true, byteLength: 1 }
    } satisfies LauncherHarnessState

    const wrapper = mount(LaunchPrimaryAction)
    const action = wrapper.get('.launch-primary-action')

    expect(action.text()).toBe('终止进程')
    expect(action.attributes('disabled')).toBeUndefined()
    expect(action.attributes('data-running')).toBe('true')
    expect(action.find('rect').exists()).toBe(true)
  })
})
