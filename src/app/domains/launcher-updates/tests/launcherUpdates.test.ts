import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import {
  apiOk,
  type ApiResult,
  type DesktopApi,
  type LauncherUpdateState
} from '@/shared/contracts'
import LauncherUpdateNotice from '@/app/shell/components/LauncherUpdateNotice.vue'
import LauncherUpdateSettingsCard from '../components/LauncherUpdateSettingsCard.vue'
import {
  resetLauncherUpdatesForTests,
  startLauncherUpdates,
  useLauncherUpdates
} from '../useLauncherUpdates'

function installApi(initial: LauncherUpdateState) {
  let listener: ((result: ApiResult<LauncherUpdateState>) => void) | undefined
  const check = vi.fn(async () => apiOk(initial))
  const openInstallerDownload = vi.fn(async () => apiOk(initial))
  const updates: DesktopApi['launcherUpdates'] = {
    getState: vi.fn(async () => apiOk(initial)),
    check,
    openInstallerDownload,
    onStateChange: (next) => {
      listener = next
      return () => {
        listener = undefined
      }
    }
  }
  window.dshLauncher = { launcherUpdates: updates } as DesktopApi
  return {
    check,
    openInstallerDownload,
    emit: (state: LauncherUpdateState) => listener?.(apiOk(state))
  }
}

const states = {
  idle: { kind: 'idle', currentVersion: '0.1.6' },
  checking: { kind: 'checking', currentVersion: '0.1.6' },
  current: {
    kind: 'up-to-date',
    currentVersion: '0.1.6',
    latestVersion: '0.1.6',
    checkedAt: '2026-09-04T10:00:00.000Z'
  },
  available: {
    kind: 'update-available',
    currentVersion: '0.1.6',
    latestVersion: '0.1.7',
    assetName: 'dshker-launcher-0.1.7-mac-arm64.dmg',
    releasePageUrl: 'https://github.com/ankye/dshker/releases/tag/v0.1.7',
    checkedAt: '2026-09-04T10:00:00.000Z'
  },
  failed: {
    kind: 'failed',
    currentVersion: '0.1.6',
    code: 'launcher.update_network_failed',
    checkedAt: '2026-09-04T10:00:00.000Z'
  }
} as const satisfies Record<string, LauncherUpdateState>

afterEach(() => {
  resetLauncherUpdatesForTests()
  window.dshLauncher = undefined
})

describe('launcher update shared state', () => {
  it('shows only a newly available version and dismisses that exact version', async () => {
    const api = installApi(states.idle)
    let updates!: ReturnType<typeof useLauncherUpdates>
    const wrapper = mount(
      defineComponent({
        setup() {
          updates = useLauncherUpdates()
          return () => h('div')
        }
      })
    )
    await flushPromises()
    expect(updates.notice.value).toBeUndefined()

    api.emit(states.available)
    expect(updates.notice.value?.latestVersion).toBe('0.1.7')
    updates.dismissNotice()
    expect(updates.notice.value).toBeUndefined()

    api.emit(states.failed)
    expect(updates.notice.value).toBeUndefined()
    wrapper.unmount()
  })

  it('runs manual checks and turns IPC rejection into visible bridge failure', async () => {
    const api = installApi(states.idle)
    await startLauncherUpdates()
    let updates!: ReturnType<typeof useLauncherUpdates>
    const wrapper = mount(
      defineComponent({
        setup() {
          updates = useLauncherUpdates()
          return () => h('div')
        }
      })
    )
    await updates.check()
    expect(api.check).toHaveBeenCalledOnce()

    api.check.mockRejectedValueOnce(new Error('destroyed'))
    await expect(updates.check()).resolves.toBe(false)
    expect(updates.error.value).toBe('bridge')
    wrapper.unmount()
  })
})

describe('Launcher update Settings card', () => {
  it.each([
    [states.idle, '尚未检查'],
    [states.checking, '正在检查 GitHub Releases'],
    [states.current, '当前安装已是'],
    [states.available, 'dshker-launcher-0.1.7-mac-arm64.dmg'],
    [states.failed, 'launcher.update_network_failed']
  ])('renders the %s state', async (state, expected) => {
    installApi(state)
    const wrapper = mount(LauncherUpdateSettingsCard)
    await flushPromises()
    expect(wrapper.text()).toContain(expected)
    wrapper.unmount()
  })

  it('checks and opens the verified installer without accepting a renderer URL', async () => {
    const api = installApi(states.available)
    const wrapper = mount(LauncherUpdateSettingsCard)
    await flushPromises()

    await wrapper.get('[data-testid="settings-check-update"]').trigger('click')
    await flushPromises()
    expect(api.check).toHaveBeenCalledWith()

    await wrapper.get('[data-testid="settings-download-update"]').trigger('click')
    await flushPromises()
    expect(api.openInstallerDownload).toHaveBeenCalledWith()
    wrapper.unmount()
  })
})

describe('LauncherUpdateNotice', () => {
  it('keeps the version transition explicit and supports download and dismiss', async () => {
    const wrapper = mount(LauncherUpdateNotice, {
      props: {
        state: states.available,
        title: '发现新版本',
        versionLabel: '版本',
        downloadLabel: '下载安装包',
        openingLabel: '正在打开',
        installHint: '请手动运行安装包',
        dismissLabel: '关闭',
        errorLabel: '失败',
        opening: false
      }
    })

    expect(wrapper.text()).toContain('0.1.6')
    expect(wrapper.text()).toContain('0.1.7')
    await wrapper.get('[data-testid="launcher-update-notice-download"]').trigger('click')
    await wrapper.get('[data-testid="launcher-update-notice-dismiss"]').trigger('click')
    expect(wrapper.emitted('download')).toHaveLength(1)
    expect(wrapper.emitted('dismiss')).toHaveLength(1)
  })
})
