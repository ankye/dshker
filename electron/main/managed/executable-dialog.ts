import { dialog } from 'electron'
import type { ExecutablePicker, ExecutableSelectionPurpose } from './executable-capabilities'
import { ManagedRootError } from './errors'

/** Electron-owned file picker for the three explicitly supported external command entries. */
export class ElectronExecutablePicker implements ExecutablePicker {
  /** Opens a native file picker without accepting a renderer-provided default path or filter. */
  async pickExecutable(purpose: ExecutableSelectionPurpose): Promise<string | undefined> {
    const result = await dialog.showOpenDialog({
      title: titleFor(purpose),
      buttonLabel: '选择可执行文件',
      properties: ['openFile']
    })
    if (result.canceled) return undefined
    if (result.filePaths.length !== 1) {
      throw new ManagedRootError(
        'managed.selection_invalid',
        'Native executable selection must contain exactly one path.'
      )
    }
    return result.filePaths[0]
  }
}

function titleFor(purpose: ExecutableSelectionPurpose): string {
  switch (purpose) {
    case 'git':
      return '选择 Git 可执行文件'
    case 'node':
      return '选择 Node.js 可执行文件'
    case 'pnpm':
      return '选择 pnpm 可执行文件或脚本'
  }
}
