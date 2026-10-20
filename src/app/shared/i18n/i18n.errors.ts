import type { ManagedOperationErrorCode } from '@/shared/contracts'

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
  'toast.error.harnessPluginIncompatible': '扩展与当前内核不兼容',
  'toast.error.harnessPortInUse': '启动端口被其他程序占用',
  'toast.error.runtimeOwnerUnavailable': '运行所有者暂不可用',
  'toast.error.runtimeOwnerIdentityMismatch': '运行所有者身份校验失败',
  'toast.error.runtimeOwnerRecordInvalid': '运行所有者记录无效',
  'toast.error.runtimeOwnerProtocolUnsupported': '运行所有者协议不兼容',
  'toast.error.runtimeOwnerConfigurationInvalid': '运行所有者配置无效',
  'toast.error.runtimeOwnerShutdownFailed': '尚未确认运行所有者已停止',
  'toast.error.gitOperationFailed': 'Git 操作失败',
  'toast.error.pluginCatalogReadFailed': '插件目录读取失败',
  'toast.error.pluginCatalogRefreshFailed': '插件目录刷新失败',
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
  'toast.error.detail.harnessPluginIncompatible':
    '当前内核与已安装扩展的版本范围不兼容。请先移除或更新控制台中列出的旧扩展，再重新启动 Web。',
  'toast.error.detail.harnessPortInUse':
    '启动所需的端口正被其他程序使用，Launcher 不会擅自停止它。请停止占用端口的程序后重试。',
  'toast.error.detail.runtimeOwnerUnavailable':
    '本次请求无法联系运行所有者，DSH 可能仍在运行。请保留当前任务，查看控制台诊断并确认所有者状态；不要重复启动或删除身份记录。',
  'toast.error.detail.runtimeOwnerIdentityMismatch':
    '本次请求因所有者身份不匹配被拒绝。请核对已注册目录和所有者身份，并保留现有任务与身份记录供诊断。',
  'toast.error.detail.runtimeOwnerRecordInvalid':
    '本次请求因所有者记录损坏被拒绝。请保留原记录并查看控制台诊断，不要删除身份或凭据来绕过校验。',
  'toast.error.detail.runtimeOwnerProtocolUnsupported':
    '本次请求因所有者协议版本不兼容被拒绝。请核对 Launcher 与内核版本一致，安排维护前保留当前运行任务。',
  'toast.error.detail.runtimeOwnerConfigurationInvalid':
    '本次请求因所有者配置校验失败被拒绝。请核对显式注册的目录与运行环境，不会推断目录或替换所有者。',
  'toast.error.detail.runtimeOwnerShutdownFailed':
    '停止操作未确认完成，DSH 可能仍在运行。请保留当前任务并查看控制台诊断，确认所有者与进程状态后再操作。',
  'toast.error.detail.gitOperationFailed': '仓库未变更。请检查网络与分支权限后重试。',
  'toast.error.detail.pluginCatalogReadFailed':
    '当前插件列表已保留。请在“控制台”查看 Git 原因；如果目录损坏，请重启 Launcher 后重试。',
  'toast.error.detail.pluginCatalogRefreshFailed':
    '当前插件列表已保留。请检查网络、代理和 GitHub 访问后重试；详细 Git 输出已写入用户目录下的 .dshlauncher/logs/plugin-catalog.log。',
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
  'toast.error.harnessPluginIncompatible': 'An extension is incompatible with the current core',
  'toast.error.harnessPortInUse': 'The launch port is held by another program',
  'toast.error.runtimeOwnerUnavailable': 'The runtime owner is unavailable',
  'toast.error.runtimeOwnerIdentityMismatch': 'Runtime owner identity verification failed',
  'toast.error.runtimeOwnerRecordInvalid': 'The runtime owner record is invalid',
  'toast.error.runtimeOwnerProtocolUnsupported': 'The runtime owner protocol is incompatible',
  'toast.error.runtimeOwnerConfigurationInvalid': 'The runtime owner configuration is invalid',
  'toast.error.runtimeOwnerShutdownFailed': 'Runtime owner shutdown is not confirmed',
  'toast.error.gitOperationFailed': 'The Git operation failed.',
  'toast.error.pluginCatalogReadFailed': 'The plugin catalog could not be read.',
  'toast.error.pluginCatalogRefreshFailed': 'The plugin catalog could not be refreshed.',
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
  'toast.error.detail.harnessPluginIncompatible':
    'The current core is outside the installed extensions’ supported version ranges. Remove or update the old extensions listed in Console, then start Web again.',
  'toast.error.detail.harnessPortInUse':
    'The launch port is in use by another program, which the Launcher will not stop on its own. Stop the program holding the port and retry.',
  'toast.error.detail.runtimeOwnerUnavailable':
    'This request could not reach the runtime owner. DSH may still be running. Preserve current tasks, inspect Console diagnostics and verify owner status; do not start a duplicate or delete identity records.',
  'toast.error.detail.runtimeOwnerIdentityMismatch':
    'The request was refused because owner identity did not match. Verify registered roots and owner identity; preserve existing tasks and identity records for diagnosis.',
  'toast.error.detail.runtimeOwnerRecordInvalid':
    'The request was refused because the owner record is damaged. Preserve the record and inspect Console diagnostics; do not delete identity or credentials to bypass verification.',
  'toast.error.detail.runtimeOwnerProtocolUnsupported':
    'The request was refused because the owner protocol version is incompatible. Verify matching Launcher and core versions, and preserve current tasks before scheduling maintenance.',
  'toast.error.detail.runtimeOwnerConfigurationInvalid':
    'The request was refused because owner configuration validation failed. Verify explicitly registered roots and the runtime environment; no roots or replacement owner will be inferred.',
  'toast.error.detail.runtimeOwnerShutdownFailed':
    'The stop operation was not confirmed. DSH may still be running. Preserve current tasks and inspect Console diagnostics; verify owner and process status before taking action.',
  'toast.error.detail.gitOperationFailed':
    'The repository is unchanged. Check network access and branch permissions, then retry.',
  'toast.error.detail.pluginCatalogReadFailed':
    'The current plugin list was kept. Check the Git reason in Console; if the checkout is damaged, restart the Launcher and retry.',
  'toast.error.detail.pluginCatalogRefreshFailed':
    "The current plugin list was kept. Check network access, proxy settings, and GitHub access, then retry. Detailed Git output is in your user directory's .dshlauncher/logs/plugin-catalog.log.",
  'toast.error.detail.unknown': 'The operation had no effect. Check the Console output and retry.',
  'toast.error.code': 'Error code',
  'toast.dismiss': 'Dismiss notification'
} as const

type RuntimeOwnerRendererCode = Extract<
  ManagedOperationErrorCode,
  `managed.runtime_owner_${string}`
>

/** One explicit local-owner title and remedy for every admitted renderer code. */
export const RUNTIME_OWNER_ERROR_MESSAGE_KEYS = {
  'managed.runtime_owner_unavailable': 'toast.error.runtimeOwnerUnavailable',
  'managed.runtime_owner_identity_mismatch': 'toast.error.runtimeOwnerIdentityMismatch',
  'managed.runtime_owner_record_invalid': 'toast.error.runtimeOwnerRecordInvalid',
  'managed.runtime_owner_protocol_unsupported': 'toast.error.runtimeOwnerProtocolUnsupported',
  'managed.runtime_owner_configuration_invalid': 'toast.error.runtimeOwnerConfigurationInvalid',
  'managed.runtime_owner_shutdown_failed': 'toast.error.runtimeOwnerShutdownFailed'
} as const satisfies Record<RuntimeOwnerRendererCode, keyof typeof zhCNErrors>

export const RUNTIME_OWNER_ERROR_DETAIL_KEYS = {
  'managed.runtime_owner_unavailable': 'toast.error.detail.runtimeOwnerUnavailable',
  'managed.runtime_owner_identity_mismatch': 'toast.error.detail.runtimeOwnerIdentityMismatch',
  'managed.runtime_owner_record_invalid': 'toast.error.detail.runtimeOwnerRecordInvalid',
  'managed.runtime_owner_protocol_unsupported':
    'toast.error.detail.runtimeOwnerProtocolUnsupported',
  'managed.runtime_owner_configuration_invalid':
    'toast.error.detail.runtimeOwnerConfigurationInvalid',
  'managed.runtime_owner_shutdown_failed': 'toast.error.detail.runtimeOwnerShutdownFailed'
} as const satisfies Record<RuntimeOwnerRendererCode, keyof typeof zhCNErrors>
