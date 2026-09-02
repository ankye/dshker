import { beforeEach, describe, expect, it } from 'vitest'
import { isLoopbackAddress, runtimeBrowser } from './runtimeBrowserState'

describe('isLoopbackAddress', () => {
  it('admits the loopback addresses dsh web can announce', () => {
    expect(isLoopbackAddress('http://127.0.0.1:3088/?token=abc')).toBe(true)
    expect(isLoopbackAddress('http://localhost:3088/')).toBe(true)
  })

  it('rejects a remote address', () => {
    expect(isLoopbackAddress('http://10.0.0.9:3088/')).toBe(false)
    expect(isLoopbackAddress('https://example.com/')).toBe(false)
  })

  it('rejects a non-http scheme and unparsable input', () => {
    expect(isLoopbackAddress('file:///etc/passwd')).toBe(false)
    expect(isLoopbackAddress('not a url')).toBe(false)
  })
})

describe('runtimeBrowser tabs', () => {
  beforeEach(() => {
    runtimeBrowser.resetTabs()
  })

  it('opens a tab at an explicit address and focuses it', () => {
    runtimeBrowser.openTab('http://127.0.0.1:3088/?token=abc')

    expect(runtimeBrowser.tabs).toHaveLength(1)
    expect(runtimeBrowser.activeTabId.value).toBe(runtimeBrowser.tabs[0]?.id)
    expect(runtimeBrowser.activeTab.value?.url).toBe('http://127.0.0.1:3088/?token=abc')
  })

  it('keeps tabs and addresses across a reset-free lifetime', () => {
    // Module-level state is what survives leaving and re-entering the route.
    runtimeBrowser.openTab('http://127.0.0.1:3088/a')
    runtimeBrowser.openTab('http://127.0.0.1:3088/b')

    expect(runtimeBrowser.tabs.map((tab) => tab.url)).toEqual([
      'http://127.0.0.1:3088/a',
      'http://127.0.0.1:3088/b'
    ])
  })

  it('records the address the guest actually navigated to', () => {
    runtimeBrowser.openTab('http://127.0.0.1:3088/')
    const id = runtimeBrowser.tabs[0]!.id
    runtimeBrowser.updateTab(id, { url: 'http://127.0.0.1:3088/session', title: 'Session' })

    expect(runtimeBrowser.tabs[0]?.url).toBe('http://127.0.0.1:3088/session')
    expect(runtimeBrowser.tabs[0]?.title).toBe('Session')
  })

  it('focuses a neighbour when the active tab closes', () => {
    runtimeBrowser.openTab('http://127.0.0.1:3088/a')
    runtimeBrowser.openTab('http://127.0.0.1:3088/b')
    const second = runtimeBrowser.tabs[1]!.id
    runtimeBrowser.closeTab(second)

    expect(runtimeBrowser.tabs).toHaveLength(1)
    expect(runtimeBrowser.activeTabId.value).toBe(runtimeBrowser.tabs[0]?.id)
  })

  it('leaves no active tab once the last one closes', () => {
    runtimeBrowser.openTab('http://127.0.0.1:3088/a')
    runtimeBrowser.closeTab(runtimeBrowser.tabs[0]!.id)

    expect(runtimeBrowser.tabs).toHaveLength(0)
    expect(runtimeBrowser.activeTabId.value).toBeUndefined()
  })

  it('ignores a close request for an unknown tab', () => {
    runtimeBrowser.openTab('http://127.0.0.1:3088/a')
    runtimeBrowser.closeTab(-1)

    expect(runtimeBrowser.tabs).toHaveLength(1)
  })
})
