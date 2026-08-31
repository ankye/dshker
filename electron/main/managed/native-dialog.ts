import { dialog } from 'electron'
import type { DirectoryPicker, DirectorySelectionPurpose } from './capabilities'
import { ManagedRootError } from './errors'

/** Electron-owned directory picker for the small allowlist of managed-directory purposes. */
export class ElectronDirectoryPicker implements DirectoryPicker {
  /** Opens a native directory picker without accepting a renderer-provided default path. */
  async pickDirectory(purpose: DirectorySelectionPurpose): Promise<string | undefined> {
    const result = await dialog.showOpenDialog({
      title: titleFor(purpose),
      buttonLabel: '选择目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled) return undefined
    if (result.filePaths.length !== 1) {
      throw new ManagedRootError(
        'managed.selection_invalid',
        'Native directory selection must contain exactly one path.'
      )
    }
    return result.filePaths[0]
  }
}

function titleFor(purpose: DirectorySelectionPurpose): string {
  switch (purpose) {
    case 'managed-root:harness':
      return '选择 Harness 根目录'
    case 'managed-root:plugins':
      return '选择插件根目录'
    case 'managed-root:presets':
      return '选择配置根目录'
    case 'managed-root:settings':
      return '选择设置根目录'
    case 'workspace-working-directory':
      return '选择工作目录'
  }
}
