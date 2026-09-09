/**
 * What a refused P2P operation means, kept separate from the primary catalogs.
 *
 * These lines are keyed by refusal category rather than by error code. There are
 * far more codes than anyone will write copy for, so a category keeps every
 * refusal readable without a per-code entry, and a new code inherits a message
 * that is still true.
 */
export const zhCNRefusals = {
  'p2p.refusal.input': '输入的内容不符合要求，请修改后重试。',
  'p2p.refusal.signedOut': '需要先登录才能继续。',
  'p2p.refusal.absent': '服务器上还没有这项记录。',
  'p2p.refusal.retry': '暂时无法完成，请稍后重试。',
  'p2p.refusal.fault': '操作未成功。已保留你的输入，可重试或稍后再试。',
  'p2p.account.invalidInput': '输入的内容不符合要求，请检查邮箱与密码后重试。'
} as const

export const enUSRefusals: Record<keyof typeof zhCNRefusals, string> = {
  'p2p.refusal.input': 'That input was refused. Adjust it and try again.',
  'p2p.refusal.signedOut': 'Signing in is required to continue.',
  'p2p.refusal.absent': 'The server has no record of this yet.',
  'p2p.refusal.retry': 'That could not complete right now. Try again shortly.',
  'p2p.refusal.fault': 'That did not succeed. Your input is kept; retry or try again later.',
  'p2p.account.invalidInput':
    'That input was refused. Check the email and password, then try again.'
}
