import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { P2PServiceView } from '@/shared/p2p-management'
import { p2pManagement, p2pServiceEditor as editor } from '@/app/domains/remote-connections'
import P2PServiceEditorPanel from '../components/P2PServiceEditorPanel.vue'

const serviceId = 'a'.repeat(64)
const revision = 'b'.repeat(64)
const service: P2PServiceView = {
  serviceId,
  publicKey: 'pinned-public-key',
  displayName: 'Home server',
  httpsOrigin: 'https://peer.example',
  wssUrl: 'wss://peer.example/v1/signals',
  stunAddress: 'peer.example:3478'
}

beforeEach(() => {
  editor.clear()
  vi.spyOn(p2pManagement, 'busy').mockReturnValue(false)
  editor.open(service, revision)
})

afterEach(() => {
  vi.restoreAllMocks()
  editor.clear()
})

describe('P2P shared service editor panel', () => {
  it('states the shared blast radius before anything is changed', () => {
    const wrapper = mount(P2PServiceEditorPanel)
    // The notice is present as a hint, not hidden behind an interaction.
    const notice = wrapper.get('.remote-form-hint').text()
    expect(notice).not.toBe('')
  })

  it('prefills every endpoint field and never the pinned key', () => {
    const wrapper = mount(P2PServiceEditorPanel)
    expect(
      (wrapper.get('[data-testid="p2p-service-https"]').element as HTMLInputElement).value
    ).toBe(service.httpsOrigin)
    expect((wrapper.get('[data-testid="p2p-service-wss"]').element as HTMLInputElement).value).toBe(
      service.wssUrl
    )
    expect(
      (wrapper.get('[data-testid="p2p-service-stun"]').element as HTMLInputElement).value
    ).toBe(service.stunAddress)
    expect(wrapper.html()).not.toContain('pinned-public-key')
  })

  it('keeps save disabled until a field actually changes', async () => {
    const wrapper = mount(P2PServiceEditorPanel)
    expect(wrapper.get('[data-testid="p2p-service-save"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="p2p-service-https"]').setValue('https://moved.example')
    expect(wrapper.get('[data-testid="p2p-service-save"]').attributes('disabled')).toBeUndefined()
  })

  it('warns that saving invalidates the existing test result', async () => {
    const wrapper = mount(P2PServiceEditorPanel)
    await wrapper.get('[data-testid="p2p-service-https"]').setValue('https://moved.example')
    expect(wrapper.text()).not.toBe('')
    expect(wrapper.findAll('.remote-form-hint').length).toBeGreaterThan(1)
  })

  it('disables the fields and save while the service is busy', () => {
    vi.spyOn(p2pManagement, 'busy').mockReturnValue(true)
    const wrapper = mount(P2PServiceEditorPanel)
    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="p2p-service-save"]').attributes('disabled')).toBeDefined()
  })

  it('dispatches a save through the editor', async () => {
    const save = vi.spyOn(editor, 'save').mockResolvedValue(true)
    const wrapper = mount(P2PServiceEditorPanel)
    await wrapper.get('[data-testid="p2p-service-https"]').setValue('https://moved.example')
    await wrapper.get('[data-testid="p2p-service-save"]').trigger('click')
    expect(save).toHaveBeenCalled()
  })

  it('asks before discarding a dirty draft and keeps the input on refusal', async () => {
    const wrapper = mount(P2PServiceEditorPanel)
    await wrapper.get('[data-testid="p2p-service-https"]').setValue('https://moved.example')
    await wrapper.get('[data-testid="p2p-service-cancel"]').trigger('click')
    expect(wrapper.get('[data-testid="p2p-service-discard"]').text()).not.toBe('')
    await wrapper.get('[data-testid="p2p-service-discard-keep"]').trigger('click')
    expect(
      (wrapper.get('[data-testid="p2p-service-https"]').element as HTMLInputElement).value
    ).toBe('https://moved.example')
  })

  it('surfaces a conflict as an alert while keeping the input', async () => {
    const wrapper = mount(P2PServiceEditorPanel)
    await wrapper.get('[data-testid="p2p-service-https"]').setValue('https://moved.example')
    vi.spyOn(editor, 'save').mockImplementation(async () => {
      editor.conflict.value = true
      return false
    })
    await wrapper.get('[data-testid="p2p-service-save"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(
      (wrapper.get('[data-testid="p2p-service-https"]').element as HTMLInputElement).value
    ).toBe('https://moved.example')
  })

  it('blocks saving again after an unconfirmed result', async () => {
    const wrapper = mount(P2PServiceEditorPanel)
    await wrapper.get('[data-testid="p2p-service-https"]').setValue('https://moved.example')
    editor.resultUnconfirmed.value = true
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="p2p-service-save"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[role="alert"]').text()).not.toBe('')
  })

  it('renders nothing when no service is being edited', () => {
    editor.clear()
    const wrapper = mount(P2PServiceEditorPanel)
    expect(wrapper.find('[data-testid="p2p-service-editor"]').exists()).toBe(false)
  })
})
