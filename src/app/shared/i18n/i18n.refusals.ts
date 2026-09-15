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
  'p2p.account.invalidInput': '输入的内容不符合要求，请检查邮箱与密码后重试。',
  // Connection refusals. A user looking at a failed tab needs to know which side
  // is the problem — the other computer, the network between them, or the
  // workbench behind it — because the fix is different in each case.
  'p2p.refusal.peerOffline': '对方电脑当前不在线：它没有登录，或者刚刚离线。',
  'p2p.refusal.notConnected': '这条连接在本机已经不存在或已经失效，可能刚刚断开。重新连接即可。',
  'p2p.refusal.localNotReady':
    '这台电脑还没准备好加入连接：P2P 没有启用、这台设备还没加入该账号，或者本地核心没有运行。请先到网络页检查。',
  'p2p.refusal.coordinatorUnavailable':
    '连不上协调服务器，两台电脑因此无法找到对方。请检查本机网络与服务器状态。',
  'p2p.refusal.noDirectPath':
    '两台电脑之间没能建立直连。请确认双方在同一网络、且没有防火墙拦截 UDP。',
  'p2p.refusal.runtimeUnavailable':
    '网络已连上，但对方的工作台没有启动起来。请在对方电脑上查看运行页。',
  'p2p.refusal.pairUnauthorized': '这台电脑的配对授权已失效，需要在远程连接页重新配对。',
  'p2p.refusal.connecting': '正在建立连接，稍等片刻即可。'
} as const

export const enUSRefusals: Record<keyof typeof zhCNRefusals, string> = {
  'p2p.refusal.input': 'That input was refused. Adjust it and try again.',
  'p2p.refusal.signedOut': 'Signing in is required to continue.',
  'p2p.refusal.absent': 'The server has no record of this yet.',
  'p2p.refusal.retry': 'That could not complete right now. Try again shortly.',
  'p2p.refusal.fault': 'That did not succeed. Your input is kept; retry or try again later.',
  'p2p.account.invalidInput':
    'That input was refused. Check the email and password, then try again.',
  'p2p.refusal.peerOffline': 'That computer is offline: it is not signed in, or just went away.',
  'p2p.refusal.notConnected':
    'This computer no longer holds that connection, or it has lapsed. Connect again.',
  'p2p.refusal.localNotReady':
    'This computer is not ready to join a connection: P2P is not enabled, this device is not in that account yet, or the local core is not running. Check the Networks page first.',
  'p2p.refusal.coordinatorUnavailable':
    'The coordination server could not be reached, so the two computers cannot find each other. Check this computer’s network and the server.',
  'p2p.refusal.noDirectPath':
    'The two computers could not reach each other directly. Check that both are on the same network and that nothing blocks UDP.',
  'p2p.refusal.runtimeUnavailable':
    'The network connected, but the workbench on the other computer did not come up. Check its Run page.',
  'p2p.refusal.pairUnauthorized':
    'This computer’s pairing authorization is gone. Pair it again from Remote Connections.',
  'p2p.refusal.connecting': 'The connection is still being established.'
}

/**
 * Prefixes whose codes all mean "the workbench behind the peer did not come up".
 *
 * The managed-harness subsystem owns the `runtime.*` and `managed.harness_*`
 * codes and adds them faster than this map is edited. A code from either family
 * reaches a peer tab when the other computer's launch is refused — a port
 * already held, a checkout that would not build, a child that crashed — and every
 * one of them asks the same thing of the user, so the family is claimed rather
 * than enumerated.
 */
const WORKBENCH_CODE_PREFIXES = ['p2p.runtime_', 'runtime.', 'managed.harness_'] as const

/**
 * The category a connection refusal belongs to.
 *
 * The coordinator and the core answer with far more codes than anyone writes
 * copy for, and the user's next step depends on the category, not the code:
 * this computer is not set up, the coordinator cannot be reached, the peer is
 * offline, the network between them cannot be crossed, the workbench behind it
 * did not start, or an authorization is gone. Anything unrecognised falls back
 * to the generic line, and the caller still shows the code itself, so a refusal
 * is never silent.
 */
export function refusalKeyForCode(code: string): keyof typeof zhCNRefusals {
  if (WORKBENCH_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) {
    return 'p2p.refusal.runtimeUnavailable'
  }
  switch (code) {
    case 'p2p.peer_offline':
      return 'p2p.refusal.peerOffline'
    // Refused because this computer has no such connection or session — or
    // because the attempt's lease lapsed — which says nothing about the other
    // computer. The fix is to connect again.
    case 'p2p.not_connected':
    case 'p2p.connection_not_found':
    case 'p2p.connection_cancelled':
    case 'p2p.lease_expired':
      return 'p2p.refusal.notConnected'
    // Refused on this side before anything reached the peer: P2P is off, this
    // device is not enrolled in that account, or the local core is gone. Saying
    // "the other computer is offline" here would send the user to the wrong
    // machine, which is exactly the mistake this map exists to prevent.
    case 'p2p.not_enabled':
    case 'p2p.device_unregistered':
    case 'p2p.credential_unavailable':
    case 'p2p.enrollment_not_found':
    case 'p2p.helper_unavailable':
    case 'p2p.helper_closed':
      return 'p2p.refusal.localNotReady'
    // Nothing is wrong with either computer: the server that lets them find each
    // other is unreachable, so no candidate pair can ever be exchanged.
    case 'p2p.server_unavailable':
      return 'p2p.refusal.coordinatorUnavailable'
    case 'p2p.direct_unavailable':
    case 'p2p.direct_closed':
      return 'p2p.refusal.noDirectPath'
    case 'p2p.pair_unauthorized':
    case 'p2p.pair_revoked':
    case 'p2p.pair_not_found':
    case 'p2p.network_revoked':
    case 'p2p.network_unauthorized':
    case 'p2p.trust_restore_rejected':
      return 'p2p.refusal.pairUnauthorized'
    case 'p2p.connection_busy':
    case 'p2p.helper_busy':
    case 'p2p.service_busy':
      return 'p2p.refusal.connecting'
    default:
      return 'p2p.refusal.fault'
  }
}
