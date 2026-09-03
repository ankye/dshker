import { describe, expect, it, vi } from 'vitest'
import { runtimeContextMenuTemplate, type RuntimeContextMenuTarget } from './runtime-context-menu'

function createTarget(): RuntimeContextMenuTarget {
  return {
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => true),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn()
  }
}

describe('runtime context menu', () => {
  it('offers only browser navigation and standard editing actions', () => {
    const target = createTarget()
    const template = runtimeContextMenuTemplate(target, 'zh-CN')

    expect(template.map((item) => (item.type === 'separator' ? 'separator' : item.label))).toEqual([
      '后退',
      '前进',
      '刷新',
      'separator',
      '剪切',
      '复制',
      '粘贴',
      '全选'
    ])
    expect(template[0]?.enabled).toBe(false)
    expect(template[1]?.enabled).toBe(true)
    expect(template.some((item) => item.label === '开发者工具')).toBe(false)
  })

  it('dispatches every command to the attached guest only', () => {
    const target = createTarget()
    const template = runtimeContextMenuTemplate(target, 'en-US')

    for (const item of template)
      item.click?.(undefined as never, undefined as never, undefined as never)

    expect(target.goBack).toHaveBeenCalledOnce()
    expect(target.goForward).toHaveBeenCalledOnce()
    expect(target.reload).toHaveBeenCalledOnce()
    expect(target.cut).toHaveBeenCalledOnce()
    expect(target.copy).toHaveBeenCalledOnce()
    expect(target.paste).toHaveBeenCalledOnce()
    expect(target.selectAll).toHaveBeenCalledOnce()
  })
})
