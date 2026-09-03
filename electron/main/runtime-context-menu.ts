import type { MenuItemConstructorOptions } from 'electron'

/** The limited guest-browser operations that DSHKer exposes on a Run page. */
export interface RuntimeContextMenuTarget {
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  cut(): void
  copy(): void
  paste(): void
  selectAll(): void
}

export type RuntimeContextMenuLocale = 'zh-CN' | 'en-US'

const labels: Readonly<Record<RuntimeContextMenuLocale, Readonly<Record<string, string>>>> = {
  'zh-CN': {
    back: '后退',
    forward: '前进',
    reload: '刷新',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选'
  },
  'en-US': {
    back: 'Back',
    forward: 'Forward',
    reload: 'Reload',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select all'
  }
}

/**
 * Builds the native right-click menu for a loopback DSH Web guest.
 *
 * The template deliberately contains only navigation and standard text editing
 * operations. External navigation, developer tools, and other Electron guest
 * capabilities remain unavailable to the page.
 */
export function runtimeContextMenuTemplate(
  target: RuntimeContextMenuTarget,
  locale: RuntimeContextMenuLocale
): MenuItemConstructorOptions[] {
  const copy = labels[locale]
  return [
    {
      label: copy.back,
      enabled: target.canGoBack(),
      click: () => target.goBack()
    },
    {
      label: copy.forward,
      enabled: target.canGoForward(),
      click: () => target.goForward()
    },
    {
      label: copy.reload,
      click: () => target.reload()
    },
    { type: 'separator' },
    {
      label: copy.cut,
      click: () => target.cut()
    },
    {
      label: copy.copy,
      click: () => target.copy()
    },
    {
      label: copy.paste,
      click: () => target.paste()
    },
    {
      label: copy.selectAll,
      click: () => target.selectAll()
    }
  ]
}
