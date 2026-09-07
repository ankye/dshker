import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '@/shared/contracts'
import type { P2PManagementApi } from '@/shared/p2p-management'

const saved = {
  revision: 'r1',
  catalogId: 'catalog',
  services: [],
  computers: [],
  forgottenServiceIds: []
}
let previous: DesktopApi | undefined
let wrapper: VueWrapper | undefined

beforeEach(() => {
  previous = window.dshLauncher
  vi.resetModules()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  window.dshLauncher = previous
})
async function render(api: Partial<P2PManagementApi>) {
  window.dshLauncher = { p2pManagement: api } as unknown as DesktopApi
  const component = (await import('../components/P2PManagementPanel.vue')).default
  wrapper = mount(component)
  await flushPromises()
  return wrapper
}

describe('P2P service management public controls (component diagnostics)', () => {
  it('distinguishes a read failure from not enabled and provides readback', async () => {
    const catalog = vi.fn(async () => ({
      ok: false as const,
      code: 'p2p.catalog_invalid' as const,
      message: 'invalid'
    }))
    const ui = await render({ catalog })
    expect(ui.get('[role="alert"]').text()).toContain('p2p.catalog_invalid')
    expect(ui.find('[data-testid="p2p-service-form"]').exists()).toBe(false)
    expect(ui.text()).not.toContain('此电脑尚未启用')
    await ui.get('.remote-section-heading button').trigger('click')
    await flushPromises()
    expect(catalog).toHaveBeenCalledTimes(2)
  })

  it('requires an explicit enable action and reads actual service fields after form submission', async () => {
    const enable = vi.fn(async () => ({ ok: true as const, data: saved }))
    const service = {
      serviceId: 'actual-service',
      publicKey: 'actual-key',
      displayName: 'Home',
      httpsOrigin: 'https://peer.example',
      wssUrl: 'wss://peer.example/v1/signals',
      stunAddress: 'peer.example:3478'
    }
    const addService = vi.fn(async () => ({
      ok: true as const,
      data: { ...saved, revision: 'r2', services: [service] }
    }))
    const ui = await render({ catalog: async () => ({ ok: true, data: null }), enable, addService })
    expect(enable).not.toHaveBeenCalled()
    await ui.get('button.prototype-button--primary').trigger('click')
    await flushPromises()
    const inputs = ui.findAll('input')
    for (const [index, value] of [
      service.displayName,
      service.httpsOrigin,
      service.wssUrl,
      service.stunAddress
    ].entries())
      await inputs[index].setValue(value)
    await ui.get('form').trigger('submit')
    await flushPromises()
    expect(addService).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 'r1',
        displayName: 'Home',
        httpsOrigin: service.httpsOrigin,
        wssUrl: service.wssUrl,
        stunAddress: service.stunAddress
      })
    )
    expect(ui.get('.p2p-services strong').text()).toBe('Home')
    expect(ui.findAll('.p2p-services dd').map((node) => node.text())).toEqual([
      service.httpsOrigin,
      service.wssUrl,
      service.stunAddress,
      service.serviceId
    ])
    expect(ui.text()).toContain('不是电脑的连接状态')
    expect((inputs[0].element as HTMLInputElement).value).toBe('')
  })

  it('keeps drafts and offers readback when an accepted save loses its reply', async () => {
    const addService = vi.fn(async () => {
      throw new Error('reply lost')
    })
    const ui = await render({ catalog: async () => ({ ok: true, data: saved }), addService })
    const values = [
      'Home',
      'https://peer.example',
      'wss://peer.example/v1/signals',
      'peer.example:3478'
    ]
    for (const [index, value] of values.entries()) await ui.findAll('input')[index].setValue(value)
    await ui.get('form').trigger('submit')
    await flushPromises()
    expect(ui.get('[role="alert"]').text()).toContain('结果未确认')
    expect(ui.findAll('input').map((node) => (node.element as HTMLInputElement).value)).toEqual(
      values
    )
    expect(ui.get('.remote-section-heading button').attributes('disabled')).toBeUndefined()
    expect(addService).toHaveBeenCalledTimes(1)
  })

  it('keeps cancellation pending until the original operation reports its real outcome', async () => {
    let finish!: (value: { ok: false; code: 'p2p.request_cancelled'; message: string }) => void
    const catalog = vi.fn(
      () =>
        new Promise<{ ok: false; code: 'p2p.request_cancelled'; message: string }>((resolve) => {
          finish = resolve
        })
    )
    const cancel = vi.fn(async () => ({ ok: true as const, data: { accepted: true } }))
    const ui = await render({ catalog, cancel })
    expect(ui.get('.remote-section-heading button').attributes('disabled')).toBeDefined()
    await ui.get('.p2p-feedback button').trigger('click')
    await flushPromises()
    expect(ui.get('[role="status"]').text()).toContain('等待原操作结束')
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ targetRequestId: expect.any(Number) })
    )
    finish({ ok: false, code: 'p2p.request_cancelled', message: 'cancelled' })
    await flushPromises()
    expect(ui.get('[role="alert"]').text()).toContain('p2p.request_cancelled')
    expect(ui.get('.remote-section-heading button').attributes('disabled')).toBeUndefined()
  })
})
