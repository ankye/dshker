import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SettingsPanel from '../components/SettingsPanel.vue'

/**
 * The start-at-boot switch in Settings.
 *
 * It reflects the native core's own platform registration, not a renderer
 * preference, and that registration can also be changed by `dshkerd autostart` on
 * the command line. So the control must read the state on mount and adopt the
 * state returned by every write, rather than trusting the value it just sent — a
 * switch that trusted its own click would keep showing "on" after a registration
 * that actually failed.
 */
describe('settings start-at-boot control', () => {
  afterEach(() => {
    delete (window as unknown as { dshLauncher?: unknown }).dshLauncher
    vi.restoreAllMocks()
  })

  /**
   * Installs a bridge whose autostart answers the test controls.
   *
   * SettingsPanel also mounts the harness, update and plugin domains, so those
   * members are present and refuse: the panel must render its own section either
   * way, and a missing member would fail the mount for an unrelated reason.
   */
  function installBridge(answers: { getState: unknown; setEnabled?: unknown }): {
    getState: ReturnType<typeof vi.fn>
    setEnabled: ReturnType<typeof vi.fn>
  } {
    const getState = vi.fn(async () => answers.getState)
    const setEnabled = vi.fn(async () => answers.setEnabled ?? answers.getState)
    const refused = async () => ({ ok: false as const, code: 'bridge' })
    ;(window as unknown as { dshLauncher?: unknown }).dshLauncher = {
      apiVersion: 1,
      autostart: { getState, setEnabled },
      launcherHarness: { getState: refused, onConsoleAppend: () => () => undefined },
      launcherUpdates: { getState: refused, onStateChange: () => () => undefined },
      pluginCatalog: { getState: refused },
      tray: {
        getCloseBehavior: async () => ({
          ok: true as const,
          data: { closeBehavior: 'minimize-to-tray' as const }
        }),
        setCloseBehavior: async () => ({
          ok: true as const,
          data: { closeBehavior: 'minimize-to-tray' as const }
        })
      }
    }
    return { getState, setEnabled }
  }

  function toggle(wrapper: ReturnType<typeof mount>) {
    return wrapper.find('.settings-autostart-toggle input')
  }

  /**
   * Opens the Launcher tab, where this control lives. The panel is tabbed and
   * opens on the DSH tab, so the section is not rendered until it is selected.
   */
  async function openLauncherTab(wrapper: ReturnType<typeof mount>): Promise<void> {
    const tabs = wrapper.findAll('.settings-tabs .page-tab')
    const launcherTab = tabs[1]
    expect(launcherTab, 'the settings panel must expose a Launcher tab').toBeDefined()
    await launcherTab!.trigger('click')
    await flushPromises()
  }

  it('reads the registration on mount and reflects it', async () => {
    const bridge = installBridge({
      getState: { ok: true, data: { installed: true, mechanism: 'launchd', supported: true } }
    })
    const wrapper = mount(SettingsPanel)
    await flushPromises()
    await openLauncherTab(wrapper)

    expect(bridge.getState).toHaveBeenCalledTimes(1)
    const input = toggle(wrapper)
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).checked).toBe(true)
    expect((input.element as HTMLInputElement).disabled).toBe(false)
    wrapper.unmount()
  })

  it('disables the control when the platform has no mechanism', async () => {
    installBridge({
      getState: {
        ok: true,
        data: { installed: false, mechanism: 'unsupported', supported: false }
      }
    })
    const wrapper = mount(SettingsPanel)
    await flushPromises()
    await openLauncherTab(wrapper)

    const input = toggle(wrapper)
    expect((input.element as HTMLInputElement).disabled).toBe(true)
    wrapper.unmount()
  })

  it('adopts the state the core reports back instead of the requested value', async () => {
    // The click asks to enable; the core answers that nothing was installed. The
    // switch must follow the machine, not the request.
    const bridge = installBridge({
      getState: { ok: true, data: { installed: false, mechanism: 'launchd', supported: true } },
      setEnabled: { ok: true, data: { installed: false, mechanism: 'launchd', supported: true } }
    })
    const wrapper = mount(SettingsPanel)
    await flushPromises()
    await openLauncherTab(wrapper)

    await toggle(wrapper).trigger('change')
    await flushPromises()

    expect(bridge.setEnabled).toHaveBeenCalledWith(true)
    expect((toggle(wrapper).element as HTMLInputElement).checked).toBe(false)
    wrapper.unmount()
  })

  it('surfaces a refusal instead of silently leaving the switch wrong', async () => {
    installBridge({
      getState: { ok: true, data: { installed: false, mechanism: 'launchd', supported: true } },
      setEnabled: { ok: false, error: { message: 'p2p.autostart_unavailable' } }
    })
    const wrapper = mount(SettingsPanel)
    await flushPromises()
    await openLauncherTab(wrapper)

    await toggle(wrapper).trigger('change')
    await flushPromises()

    expect(wrapper.find('.settings-autostart-error').text()).toContain('p2p.autostart_unavailable')
    expect((toggle(wrapper).element as HTMLInputElement).checked).toBe(false)
    wrapper.unmount()
  })

  it('reports the feature unavailable when no core bridge is present', async () => {
    // Everything except autostart is present, so the mount is normal and the only
    // missing capability is the one under test.
    const bridge = installBridge({ getState: { ok: true, data: {} } })
    delete (
      (window as unknown as { dshLauncher: { autostart?: unknown } }).dshLauncher as {
        autostart?: unknown
      }
    ).autostart
    void bridge
    const wrapper = mount(SettingsPanel)
    await flushPromises()
    await openLauncherTab(wrapper)

    // The section still renders, but the control reports the feature unavailable
    // rather than offering an action that cannot reach a core.
    expect((toggle(wrapper).element as HTMLInputElement).disabled).toBe(true)
    wrapper.unmount()
  })
})
