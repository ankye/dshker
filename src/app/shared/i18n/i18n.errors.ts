/** Error and recovery copy, kept separate from the primary locale catalogs. */
export const zhCNErrors = {
  'toast.error.title': '操作失败',
  'toast.error.bridge': '桌面桥接不可用',
  'toast.error.harnessLaunchFailed': '内核切换或启动操作失败',
  'toast.error.harnessBusyRunning': 'DSH Web 正在运行',
  'toast.error.harnessLaunchInProgress': '已有操作正在进行',
  'toast.error.harnessWorktreeInvalid': '内核目录不可用',
  'toast.error.harnessInputInvalid': '操作参数无效',
  'toast.error.harnessPluginOperationFailed': '扩展安装或卸载失败',
  'toast.error.gitOperationFailed': 'Git 操作失败',
  'toast.error.detail.bridge': '桌面能力未就绪，读取和注册目录暂不可用。请重启 Launcher 后重试。',
  'toast.error.detail.harnessLaunchFailed':
    '内核未启动。请在“控制台”查看输出，确认版本可用后重试。',
  'toast.error.detail.harnessBusyRunning':
    '切换内核版本或增删扩展前需要先停止 DSH Web。请在“一键启动”停止后重试。',
  'toast.error.detail.harnessLaunchInProgress': '上一个内核操作尚未结束。请等待其完成后重试。',
  'toast.error.detail.harnessWorktreeInvalid':
    '`~/.dshlauncher/harness` 尚未就绪或已损坏。请先完成内核安装，再执行该操作。',
  'toast.error.detail.harnessInputInvalid': '该选项已不再有效。请刷新列表后重新选择。',
  'toast.error.detail.harnessPluginOperationFailed':
    'DSH 扩展命令执行失败，扩展列表保持原样。请在“控制台”查看输出后重试。',
  'toast.error.detail.gitOperationFailed': '仓库未变更。请检查网络与分支权限后重试。',
  'toast.error.detail.unknown': '操作未生效。请在“控制台”查看输出后重试。',
  'toast.error.code': '错误码',
  'toast.dismiss': '关闭提示'
} as const

/** English counterparts for the shared error and recovery messages. */
export const enUSErrors = {
  'toast.error.title': 'Operation failed',
  'toast.error.bridge': 'Desktop bridge is unavailable',
  'toast.error.harnessLaunchFailed': 'The core switch or launch operation failed.',
  'toast.error.harnessBusyRunning': 'DSH Web is running',
  'toast.error.harnessLaunchInProgress': 'Another operation is in progress',
  'toast.error.harnessWorktreeInvalid': 'The core directory is unavailable',
  'toast.error.harnessInputInvalid': 'The selection is invalid',
  'toast.error.harnessPluginOperationFailed': 'Extension install or removal failed',
  'toast.error.gitOperationFailed': 'The Git operation failed.',
  'toast.error.detail.bridge':
    'Desktop capabilities are not ready, so reading and registering directories is unavailable. Restart the Launcher and retry.',
  'toast.error.detail.harnessLaunchFailed':
    'The core did not start. Check the Console output, confirm the version is usable, and retry.',
  'toast.error.detail.harnessBusyRunning':
    'Stop DSH Web before switching the core version or changing extensions. Stop it in Launch, then retry.',
  'toast.error.detail.harnessLaunchInProgress':
    'The previous core operation has not finished. Wait for it to complete and retry.',
  'toast.error.detail.harnessWorktreeInvalid':
    '`~/.dshlauncher/harness` is not ready or is damaged. Finish installing the core, then retry.',
  'toast.error.detail.harnessInputInvalid':
    'That selection is no longer valid. Refresh the list and choose again.',
  'toast.error.detail.harnessPluginOperationFailed':
    'The DSH extension command failed and the extension list is unchanged. Check the Console output and retry.',
  'toast.error.detail.gitOperationFailed':
    'The repository is unchanged. Check network access and branch permissions, then retry.',
  'toast.error.detail.unknown': 'The operation had no effect. Check the Console output and retry.',
  'toast.error.code': 'Error code',
  'toast.dismiss': 'Dismiss notification'
} as const
