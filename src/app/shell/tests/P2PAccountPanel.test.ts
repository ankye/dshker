import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '@/shared/contracts'
import type { P2PManagementApi } from '@/shared/p2p-management'

const user = { userId: 'user-a', username: 'alice' }
const network = { networkId: 'net-a', userId: user.userId, name: 'Office' }
let previous: DesktopApi | undefined
let wrapper: VueWrapper | undefined
let container: HTMLDivElement | undefined
beforeEach(() => {
  previous = window.dshLauncher
  vi.resetModules()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  container?.remove()
  container = undefined
  window.dshLauncher = previous
})
async function render(api: Partial<P2PManagementApi>) {
  window.dshLauncher = { p2pManagement: api } as unknown as DesktopApi
  const panel = (await import('../components/P2PAccountPanel.vue')).default
  container = document.createElement('div')
  document.body.append(container)
  wrapper = mount(panel, {
    attachTo: container,
    props: { serviceId: 'service-a', displayName: 'Home' }
  })
  await flushPromises()
  return wrapper
}
function button(ui: VueWrapper, text: string) {
  const found = ui.findAll('button').find((node) => node.text() === text)
  if (!found) throw new Error(`Missing public button: ${text}`)
  return found
}

describe('P2P account public controls (component diagnostics)', () => {
  it('clears submitted passwords and reads the user and networks without guessing a selection', async () => {
    const login = vi.fn<P2PManagementApi['login']>().mockResolvedValue({ ok: true, data: user })
    const networks = vi
      .fn<P2PManagementApi['networks']>()
      .mockResolvedValue({ ok: true, data: [network] })
    const ui = await render({
      currentUser: async () => ({
        ok: false,
        code: 'p2p.user_login_required',
        message: 'required'
      }),
      login,
      networks
    })
    await ui.get('input[autocomplete="username"]').setValue('alice')
    await ui.get('input[type="password"]').setValue('secret-login')
    await ui.get('form').trigger('submit')
    await flushPromises()
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: 'service-a',
        username: 'alice',
        password: 'secret-login'
      })
    )
    expect(ui.find('input[type="password"]').exists()).toBe(false)
    expect(ui.text()).toContain(user.userId)
    expect(networks).not.toHaveBeenCalled()
    await button(ui, '读取网络列表').trigger('click')
    await flushPromises()
    expect(ui.get('.p2p-network-list').text()).toContain(network.networkId)
    expect(ui.get('.p2p-network-list').text()).toContain(network.name)
    expect((ui.get('input[type="radio"]').element as HTMLInputElement).checked).toBe(false)
    await ui.get('input[type="radio"]').setValue(true)
    expect(ui.text()).toContain('选定网络: net-a')
    const { p2pAccounts } = await import('@/app/domains/remote-connections')
    expect(JSON.stringify(p2pAccounts.state('service-a'))).not.toContain('secret-login')
  })

  it('previews exact network deletion, blocks unconfirmed re-submission and resolves through readback', async () => {
    const networks = vi
      .fn<P2PManagementApi['networks']>()
      .mockResolvedValue({ ok: true, data: [network] })
    const deleteNetwork = vi.fn<P2PManagementApi['deleteNetwork']>().mockResolvedValue({
      ok: false,
      code: 'p2p.management_result_unconfirmed',
      message: 'unconfirmed'
    })
    const ui = await render({
      currentUser: async () => ({ ok: true, data: user }),
      networks,
      deleteNetwork
    })
    await button(ui, '读取网络列表').trigger('click')
    await flushPromises()
    await button(ui, '删除网络').trigger('click')
    expect(deleteNetwork).not.toHaveBeenCalled()
    const confirmation = ui.get('.p2p-delete-confirm')
    expect(document.activeElement).toBe(confirmation.get('button').element)
    expect(confirmation.text()).toContain('Office · net-a')
    expect(confirmation.text()).toContain('撤销此网络的设备绑定和配对授权')
    await confirmation.get('button').trigger('click')
    await flushPromises()
    expect(deleteNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'service-a', networkId: 'net-a' })
    )
    expect(ui.get('.p2p-delete-confirm button').attributes('disabled')).toBeDefined()
    await button(ui, '重新读取用户').trigger('click')
    await flushPromises()
    expect(ui.get('.p2p-delete-confirm button').attributes('disabled')).toBeDefined()
    networks.mockResolvedValueOnce({ ok: true, data: [] })
    await button(ui, '读取网络列表').trigger('click')
    await flushPromises()
    expect(ui.find('.p2p-delete-confirm').exists()).toBe(false)
    expect(document.activeElement).toBe(ui.get('h3').element)
    expect(ui.findAll('.p2p-network-list li')).toHaveLength(0)
    expect(ui.text()).toContain('此用户没有网络')
    expect(deleteNetwork).toHaveBeenCalledTimes(1)
  })

  it('submits create and rename forms with original identities and displays returned names', async () => {
    const renamed = { ...network, name: 'Office updated' }
    const created = { ...network, networkId: 'net-new', name: 'Lab' }
    const renameNetwork = vi
      .fn<P2PManagementApi['renameNetwork']>()
      .mockResolvedValue({ ok: true, data: renamed })
    const createNetwork = vi
      .fn<P2PManagementApi['createNetwork']>()
      .mockResolvedValue({ ok: true, data: created })
    const ui = await render({
      currentUser: async () => ({ ok: true, data: user }),
      networks: async () => ({ ok: true, data: [network] }),
      renameNetwork,
      createNetwork
    })
    await button(ui, '读取网络列表').trigger('click')
    await flushPromises()
    const rename = ui.get('.p2p-network-list form')
    expect((rename.get('input').element as HTMLInputElement).value).toBe('Office')
    await rename.get('input').setValue('Office updated')
    await rename.trigger('submit')
    await flushPromises()
    expect(renameNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: 'service-a',
        networkId: 'net-a',
        name: 'Office updated'
      })
    )
    const create = ui.findAll('form').at(-1)!
    await create.get('input').setValue('Lab')
    await create.trigger('submit')
    await flushPromises()
    expect(createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'service-a', name: 'Lab' })
    )
    expect(ui.findAll('.p2p-network-list li').map((node) => node.get('label').text())).toEqual([
      'Office updated',
      'Lab'
    ])
    expect(ui.text()).toContain('net-new')
    expect(
      ui.findAll('input[type="radio"]').every((node) => !(node.element as HTMLInputElement).checked)
    ).toBe(true)
  })
})
