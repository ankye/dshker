import type { SupportedLocale } from './i18n'

/** Selects the locale section from a structured release body. */
export function selectLocalizedReleaseNotes(
  notes: string | undefined,
  selectedLocale: SupportedLocale
): string | undefined {
  if (notes === undefined) return undefined
  const sections = [...notes.matchAll(/^###\s+.*?\((zh-CN|en-US)\)\s*$/gmu)]
  if (sections.length === 0) return undefined
  const selected = sections.find((match) => match[1] === selectedLocale)
  if (selected === undefined || selected.index === undefined) return undefined
  const bodyStart = selected.index + selected[0].length
  const next = sections.find((match) => (match.index ?? Number.POSITIVE_INFINITY) > selected.index!)
  return notes.slice(bodyStart, next?.index ?? notes.length).trim() || undefined
}

/**
 * Launcher update copy, kept out of the primary catalogs.
 *
 * This is the one place a user is told a new version exists and what changed, so
 * it stays grouped instead of being scattered through a catalog that is already
 * at its size budget. The notes body itself arrives from the GitHub release at
 * runtime; only its heading lives here.
 */
export const zhCNUpdates = {
  'settings.update.title': '应用更新',
  'settings.update.description': '从 GitHub Releases 检查适用于当前系统的 DSHKer Launcher 安装包。',
  'settings.update.currentVersion': '当前版本',
  'settings.update.latestVersion': '最新版本',
  'settings.update.status.loading': '正在读取',
  'settings.update.status.idle': '尚未检查',
  'settings.update.status.checking': '检查中',
  'settings.update.status.current': '已是最新',
  'settings.update.status.available': '有新版本',
  'settings.update.status.failed': '检查失败',
  'settings.update.loading': '正在读取应用更新状态。',
  'settings.update.idle': '尚未检查 GitHub 上的最新发布版本。',
  'settings.update.checking': '正在检查 GitHub Releases…',
  'settings.update.upToDate': '当前安装已是适用于此系统的最新版本。',
  'settings.update.available': '已找到适用于当前系统的新安装包。',
  'settings.update.asset': '安装包',
  'settings.update.notesTitle': '更新内容',
  'settings.update.checkedAt': '检查时间',
  'settings.update.installHint':
    '点击下载后会保存到系统“下载”目录；完成后请退出 Launcher 并手动运行安装包。',
  'settings.update.check': '检查更新',
  'settings.update.checkingAction': '正在检查…',
  'settings.update.retry': '重新检查',
  'settings.update.download': '下载安装包',
  'settings.update.downloading': '正在下载…',
  'settings.update.downloadProgress': '下载进度',
  'settings.update.downloaded': '下载完成，安装包已保存到系统“下载”目录。',
  'settings.update.operationFailed': '更新操作未完成，请根据诊断代码重试。',
  'settings.update.errorCode': '诊断代码',
  'settings.update.error.invalidRequest': '更新请求无效，请重新打开应用后再试。',
  'settings.update.error.network': '无法连接 GitHub，请检查网络后重试。',
  'settings.update.error.http': 'GitHub Releases 暂时未返回可用结果，请稍后重试。',
  'settings.update.error.response': 'GitHub Releases 返回了无法识别的数据。',
  'settings.update.error.release': '最新发布版本的信息不符合 Launcher 的更新要求。',
  'settings.update.error.platform': '最新发布版本不支持当前操作系统或处理器架构。',
  'settings.update.error.asset': '最新发布版本没有唯一匹配当前系统的安装包。',
  'settings.update.error.notAvailable': '当前没有可下载的新版本。',
  'settings.update.error.download': '安装包下载失败，请重试。',
  'settings.update.error.destinationExists': '系统“下载”目录中已经存在同名安装包。'
} as const

export const enUSUpdates = {
  'settings.update.title': 'Application updates',
  'settings.update.description':
    'Check GitHub Releases for a DSHKer Launcher installer built for this system.',
  'settings.update.currentVersion': 'Current version',
  'settings.update.latestVersion': 'Latest version',
  'settings.update.status.loading': 'Reading',
  'settings.update.status.idle': 'Not checked',
  'settings.update.status.checking': 'Checking',
  'settings.update.status.current': 'Up to date',
  'settings.update.status.available': 'Update available',
  'settings.update.status.failed': 'Check failed',
  'settings.update.loading': 'Reading the application update state.',
  'settings.update.idle': 'The latest GitHub release has not been checked yet.',
  'settings.update.checking': 'Checking GitHub Releases…',
  'settings.update.upToDate': 'This installation is the latest version available for this system.',
  'settings.update.available': 'A newer installer is available for this system.',
  'settings.update.asset': 'Installer',
  'settings.update.notesTitle': "What's new",
  'settings.update.checkedAt': 'Checked',
  'settings.update.installHint':
    'The installer is saved to your system Downloads folder. Quit Launcher and run it manually after the download finishes.',
  'settings.update.check': 'Check for updates',
  'settings.update.checkingAction': 'Checking…',
  'settings.update.retry': 'Check again',
  'settings.update.download': 'Download installer',
  'settings.update.downloading': 'Downloading…',
  'settings.update.downloadProgress': 'Download progress',
  'settings.update.downloaded':
    'Download complete. The installer was saved to your system Downloads folder.',
  'settings.update.operationFailed':
    'The update action did not finish. Use the diagnostic code and try again.',
  'settings.update.errorCode': 'Diagnostic code',
  'settings.update.error.invalidRequest':
    'The update request was invalid. Reopen the app and try again.',
  'settings.update.error.network': 'GitHub could not be reached. Check your network and try again.',
  'settings.update.error.http':
    'GitHub Releases did not return an available result. Try again later.',
  'settings.update.error.response': 'GitHub Releases returned data this Launcher cannot read.',
  'settings.update.error.release':
    'The latest release information is not supported by this Launcher.',
  'settings.update.error.platform':
    'The latest release does not support this operating system or processor architecture.',
  'settings.update.error.asset':
    'The latest release does not contain one unambiguous installer for this system.',
  'settings.update.error.notAvailable': 'There is no newer installer to download.',
  'settings.update.error.download': 'The installer download failed. Try again.',
  'settings.update.error.destinationExists':
    'An installer with the same name already exists in the system Downloads folder.'
} as const
