# Changelog

## 0.1.59 — 2026-09-17

- **远程工作台加载失败时显示友好的排障页面。** 此前防火墙拦截 UDP 导致连接建立后
  webview 白屏并显示裸的 `p2p.stream_failed`，现在页面用中/英文列出常见原因和检查
  步骤（防火墙、UDP 连通性、网络环境），用户无需查阅文档即可自助修复。
- **`p2p.stream_failed` 错误码纳入连接失败分类体系。** 如果该代码出现在连接状态中，
  也正确归入「直连不可达」类别，显示对应的中文/英文提示。

## 0.1.58 — 2026-09-17

- **修复第三台及以上设备无法建立连接、断线后长时间无法恢复。** 协调器过去按**目标
  设备**索引连接尝试，因此一个目标同时只允许一个拨号方。而网络上限 10 台、自动连接
  会向每个已授权配对拨号，于是三台以上时两台机器争同一目标会互相饿死；更关键的是
  活跃会话每 20 秒续租一次，那个 `p2p.connection_busy` 拒绝**永不失效**——对端还活着
  时，你重拨永远被拒，这就是"断线不能恢复"。改为按尝试 id 索引（双方在续租、结束和
  每条信令里本来就都带这个值），租约的 `pairId` 字段保持不变以兼容已部署的客户端。
- **修复撤销/删除配对后对方仍能连接。** 两条路径都只写了 `pairs.state='revoked'`，
  而授权判定走的是"网络共同成员"，两端仍然绑定，所以照旧发放租约、活跃会话照旧续租。
  界面当时明确写着"撤销会立即断开与这台电脑的 P2P 会话"，那句话是假的。现在撤销在
  发起和续租两处都会被强制检查。

- **修复同一设备重连被永久拒绝（连不上、断线不恢复）。** 一台设备只持有一条信令
  连接：设备 id 由公钥派生、连接经 mTLS 认证，所以新连接必然是同一台机器重连，
  最新的那条才是活的。但协调器过去是**拒绝新连接**（`p2p.device_busy`）而不是踢掉
  旧的。这条 socket 上没有 ping/pong、没有读超时、也没有空闲检测，而且 Hijack 之后
  Go 会清掉原有的 deadline，因此客户端被强杀、或 NAT/防火墙静默丢弃连接时，服务端
  永远不会发现——那条死连接连同它的 goroutine、channel 和 TCP socket 一直留着，
  该设备**在进程重启前再也无法建立信令连接**。客户端把它变成了死局：没有任何代码
  读 `p2p.device_busy`，而它含 "busy" 子串会被归类为 `retry`，于是界面一直提示
  "稍后重试"，永远重试不成功。现在新连接顶替旧连接。
- **修复顶替可能导致两端无限互踢。** 被顶替的一方必须停下，不能重连。客户端的
  supervisor 在任何断连后 1 秒就重连，而重连会顶掉对方，对方再过 1 秒又顶回来——
  无限循环，两边都不可用。协调器改为发送带明确原因的关闭帧
  （`p2p.signal_superseded`，而非直接切断），客户端据此判定"我是被顶替的"并停止
  重连、保持 down 状态，这样后续尝试会立刻返回真实错误码而不是挂起。仅靠突然断开
  无法与"网络断了"区分，所以这个原因字符串是两端的协议约定。

- **修复 macOS 菜单栏看不到托盘图标。** 托盘直接用 `icon-512.png`——一张 512px、
  96% 不透明、平均色为中灰的应用插画——缩到 16px 后就是一团灰方块，在菜单栏里与
  "没有图标"无法区分。macOS 需要的是 template 图像（纯黑 + alpha，由系统按浅色/
  深色菜单栏重新着色并在高亮时反色），因此新增专用字形 `trayTemplate.png`（附 @2x
  供 Retina 使用）并调用 `setTemplateImage(true)`。Windows 和 Linux 没有 template
  约定、按原图绘制，继续使用彩色应用图标。
- **修复单击托盘图标直接退出应用。** `tray.on('click')` 绑的是 `quitApp()`，所以
  在菜单栏上误点一下就无确认地杀掉整个应用，而同一个托盘菜单里还另有一项"显示"
  做同样的手势。现在左键单击改为显示窗口，退出只保留为明确的菜单项。
- **修复托盘创建失败后应用彻底无法退出。** `isTrayActive()` 决定
  `window-all-closed` 是否放行退出，而 `currentBehavior` 在 `new Tray()` 之前就已
  被赋值。若构造抛错（Linux 无系统托盘、图标缺失或损坏），关闭处理器根本没装上，
  窗口真的关掉了，但 `window-all-closed` 仍认为托盘生效而提前返回——于是没有窗口、
  没有托盘图标、也没有任何退出途径，单实例锁还被占着。现在构造失败会退回
  `quit` 行为，让关闭按钮成为可用的退出出口。

- **修复 ⌘Q / 菜单退出后进程残留、托盘图标消失、只能强制结束进程。** 0.1.56 和
  0.1.57 只修好了托盘那一条退出路径：`forceQuitting` 标志仅由托盘的 `quitApp()`
  设置，而 ⌘Q、应用菜单"退出"、Dock 右键退出和终止信号都直接走 `app.quit()`，
  绕过了它。于是退出流程跑完（core 被停掉、P2P 会话被关闭），Electron 关窗口时
  "最小化到托盘"拦截器仍然生效，`preventDefault()` + `hide()` 取消了这次退出。
  结果是一个看不见的进程：没有窗口、没有托盘图标（已在退出流程开头被销毁）、
  core 已停止、单实例锁仍被占用——再次双击快捷方式只会 `show()` 那个背后没有
  core 的空窗口，P2P 也因此再也连不上。现在所有退出路径共用一个退出序列，
  **第一步**就解除关闭拦截。
- **修复清理失败后永远退不出去。** 任一 owner 清理失败时，旧代码复位
  `shutdownInProgress`、不再调用 `app.quit()`，之后每次退出都重跑同一个必然失败
  的清理。现在清理失败仍然结束进程（退出码 1）并记录原因：用户已经要求离开，
  留下一个占着单实例锁的隐藏进程比不干净的退出更糟。
- **托盘图标改为在退出确定继续之后才销毁。** 之前在退出流程开头就销毁，一旦清理
  失败，用户连唯一可用的重试入口也没了。
- **缩短退出时的卡顿。** `stopChild` 原先无条件先等 10 秒才发 SIGTERM；私有通道
  关闭本身就是 core 的停止信号，正常情况 1 秒内即退出，因此首次等待缩短为 1 秒，
  升级到 SIGTERM/SIGKILL 的预算不变。

## 0.1.57 — 2026-09-17

- **修复双击快捷方式无法恢复隐藏到托盘的窗口。** `second-instance` 事件处理器只处理
  了最小化窗口（`isMinimized()` → `restore()`），未处理隐藏到系统托盘的状态。窗口
  `isMinimized()` 返回 false、`focus()` 对隐藏窗口无效，用户双击桌面/开始菜单图标
  后看不到任何反应。现在增加了 `show()`，与托盘菜单"显示 DSHKer Launcher"一致，将
  隐藏窗口重新显示到前台。Windows 和 macOS 同时生效。
- **修复托盘右键菜单"退出"后进程残留。** `forceQuitting` 标志和关闭拦截已在 0.1.56
  中实现，但托盘右键"退出"按钮直接调用了 `app.quit()` 而非 `quitApp()`，导致
  `forceQuitting` 未被设置，关闭拦截器用 `preventDefault` 阻止了进程退出，窗口被
  隐藏后进程仍占着单实例锁，后续双击快捷方式无法启动。现在托盘"退出"正确调用
  `quitApp()` 设置标志后退出。

## 0.1.56 — 2026-09-17

- **修复 Mac 重启后 Windows 连不上（`p2p.connection_busy`）。** 新 Connect 无条件替代
  旧 session，不再检查 transport 是否还活着——ICE 检测远端断开需要 25-30 秒，
  `retireDeadLocked` 在这个窗口期内返回 false 导致新连接被拒。现在旧 session 被
  直接取消替换，不管它的 transport 状态如何。
- **修复 `p2p.runtime_http_failed`。** `ServeDirectoryStreams` 的 `mux.Accept()`
  与 HTTP gateway 的 `Listener.Accept` 竞争 stream 通道，HTTP 请求帧被目录服务
  吃掉后无处转发导致 probe 失败。临时禁用此功能，待 stream 分流机制就绪后再接
  入。
- **修复托盘退出后无法启动。** 托盘 `app.quit()` 被窗口 close handler 的
  `preventDefault` 拦截，进程没退出却销毁了托盘和隐藏了窗口。`forceQuitting` 标
  志让真正退出绕过拦截。

## 0.1.55 — 2026-09-16

- **系统托盘图标。** 桌面右下角（Windows）或菜单栏（macOS）新增 DSHKer Launcher
  托盘图标。点击托盘图标直接退出程序；右键菜单提供"显示"/"切换关闭行为"/"退
  出"操作。
- **关闭按钮默认最小化到托盘。** 点击窗口关闭按钮不再退出程序，而是隐藏到系
  统托盘，程序继续在后台运行。可在**设置 > 关闭行为**中切换为"直接退出"。
- **设置面板新增关闭行为选项。** 设置 → Launcher 标签页新增"关闭行为"配置
  项，可选"最小化到系统托盘"或"直接退出"，切换即时生效并持久化。
- **修复 CI 构建失败。** prettier 格式检查和类型检查问题已修复，预加载表面测
  试已更新以包含新的 tray IPC 通道，mock 中补充了缺失的 tray 桩。

## 0.1.54 — 2026-09-16

- **系统托盘图标。** 桌面右下角（Windows）或菜单栏（macOS）新增 DSHKer Launcher
  托盘图标。点击托盘图标直接退出程序；右键菜单提供"显示"/"切换关闭行为"/"退
  出"操作。
- **关闭按钮默认最小化到托盘。** 点击窗口关闭按钮不再退出程序，而是隐藏到系
  统托盘，程序继续在后台运行。可在**设置 > 关闭行为**中切换为"直接退出"。
- **设置面板新增关闭行为选项。** 设置 → Launcher 标签页新增"关闭行为"配置
  项，可选"最小化到系统托盘"或"直接退出"，切换即时生效并持久化。

## 0.1.53 — 2026-09-16

- **远程工作区目录浏览已修复。** P2P 连接的远端目录服务
  `ServeDirectoryStreams` 从未接入 `Manager.run()`（v0.1.48 引入后一直是死代
  码），所以每次 `remote.roots` RPC 请求发出后，远端 mux 上无人应答，请求挂
  起超时，用户看到"添加远程工作区"无法拉起远端文件夹目录。现在应答方的
  `Manager` 持有 `RootProvider`，在连接建立后启动 `ServeDirectoryStreams` 监
  听目录请求，通过私有通道向 Launcher 获取授权根目录列表并应答。
- 授权根目录管理尚未接入用户界面，当前返回空列表（远端显示"尚未授权任何目
  录"），后续通过 workspace registry 接入实际目录授权后即可浏览远端文件夹。

## 0.1.52 — 2026-09-16

- **The window stays visible when monitors or RDP sessions change.** Disconnecting
  an external monitor, ending a remote-desktop session, or switching display
  layouts could leave the Launcher window on a desktop that no longer exists —
  positioned where a secondary monitor used to be, or at the resolution of the
  RDP session that just ended. The window is now repositioned to the centre of
  the primary display whenever the display configuration changes, and on every
  startup it checks that its saved bounds sit on at least one available display.
- **Window position and size survive a restart.** The last window bounds are
  written on every move or resize and restored on the next launch.
- **Double-clicking the shortcut now brings up the running window instead of
  starting a second process.** An Electron single-instance lock prevents the
  multiple processes that shared the same data root, core socket and catalog
  files — the extra instance failed to start its own dshkerd (the data directory
  was taken), and the user saw nothing at all.

## 0.1.51 — 2026-09-16

- **A stale session after a peer restarted no longer blocks reconnection.**
  When the remote machine went offline and came back, the old session's
  transport endpoints still occupied the outbound (or inbound) slot at the
  moment the new connect arrived, and every attempt was refused as
  `p2p.connection_busy`. The connect path now retires a session whose
  context or transport is already done — the peer is gone and the cleanup is
  merely racing the next attempt — so a fresh one replaces it instead of
  being denied by a corpse.
- **Disconnect now tears down an inbound (answered) session.** The
  Disconnect function only checked the outbound `sessions` map, so a session
  created by the far side dialling this machine could not be terminated from
  the Run page; the button returned `p2p.not_connected` and the session
  lived on. The inbound map is checked too, so the user can close a session
  regardless of which side opened it.

## 0.1.50 — 2026-09-16

- **A pair now owns one session per direction, not one slot shared between both.**
  This machine's own Run tab dials out; the far machine's tab is the answered
  session here. Before, whichever side dialled first kept the other side's
  "connect" answering `p2p.connection_busy` for as long as its session lived,
  with a tab that showed the answered session's stage and no address of its own
  to load — a function that had already connected appeared disabled with no
  explanation. The core now tracks inbound sessions and their endpoints
  separately from outbound ones, and revocation clears both attachments.
- **A restarted process no longer writes off every peer as stale.** Attempt
  generations were seeded from a counter starting at 1, so a fresh process that
  was forced to reconnect named every attempt "older" than the previous process's
  last attempt: the peer refused it as stale, the stage never recorded it, and
  every runtime request that followed died as `p2p.runtime_request_unscoped`
  until that peer restarted too. Generations are now seeded from the wall clock,
  so each process start sets every attempt above anything the peer has seen
  before — including peers running builds that never learned attempt lineages.
- **A failed result from asking about a connection no longer locks that tab
  forever.** A promise that rejected left the in-flight marker in place, so the
  tab never asked again and entered a terminal state: "ready" with no page
  loaded. The ask now catches the refusal and clears the marker, so the next
  render cycle retries normally.
- **The host no longer refuses answered runtime requests for not being in a
  "starting-runtime" stage that the inbound session's document was never told.**
  The core owns one slot per direction now and asks for a runtime only while an
  answered attempt is at `starting-runtime`, so the only gate is whether the pair
  is still recorded and active. Requiring a stage the doc never had made every
  answered attempt die as `p2p.runtime_request_unscoped`.

## 0.1.49 — 2026-09-16

- **0.1.48 could not connect to any paired computer.** The list of paired
  computers moved into the core in 0.1.48, and the pin that authorizes a connection
  was recorded under the server's own pairing id instead of the id a connection
  actually names — the far computer's device id. Nothing could look that pin up, so
  every attempt was refused with `p2p.pair_unauthorized`, and that refusal is one
  auto-reconnect treats as final: each computer was written off after a single
  attempt until the machine's own network changed. SSH connections were unaffected.
- The pins are now in place before the core reports the machine online. A
  connection made in the first seconds after launch used to be refused for a pin
  that had not been derived yet, which looked exactly like a computer that cannot
  be reached.
- **A connect button that does nothing now says why.** Refusals that prove nothing
  was started (the helper or the service was busy) no longer count as an unknown
  outcome that blocks every later attempt; a refusal is read back so the attempt is
  resolved where it happened, and the Run page reads the connection state when it
  opens instead of only the Remote connections page doing so. A disabled connect
  button explains itself, and a refused attempt leaves its code on screen.
- A computer that was refused before its pin existed is tried again as soon as the
  core announces a new paired-computer list, instead of staying written off until
  the machine's network changes.
- A failed paired-computer pass is written to the core's log rather than dropped:
  its only symptom used to be "this computer will not connect".

## 0.1.48 — 2026-09-15

- **The paired-computer list looks after itself.** Which computers you may connect
  to was rebuilt whenever a page asked for it: the Run tab read the server's
  pairings, pinned them and rewrote the stored list, so a computer paired elsewhere
  appeared only the next time that menu was opened, and a list nobody opened could
  stay wrong. The core now does that work on its own — on the same 30-second
  interval it already uses for the network device list, and immediately after
  anything that can change a pairing (joining or leaving a network, binding or
  unbinding a device, approving, revoking or adopting one) — and tells the window
  when the list changes. A computer paired elsewhere appears while the list is
  open; leaving a network drops its computer right away instead of up to half a
  minute later.
- Opening the Run tab no longer asks the server anything: it reads what the core
  already holds.

## 0.1.47 — 2026-09-15

- **A window that vanishes now says why.** When a renderer, a GPU or utility
  process, or the main process itself dies, the reason and exit code are written
  to `~/.dshlauncher/logs/main-faults.log` before the process goes. Until now the
  application had no such record at all: a crashed renderer and a window someone
  had closed looked identical from the outside, so "it just closed" could not be
  answered from the machine. An uncaught exception in the main process is recorded
  and then ends the process deliberately, with the exit code the default would have
  produced; a renderer or child process that dies is recorded and left for Electron
  to recover, because exiting there would turn a recoverable loss into a shutdown.
- This is a record of unexpected deaths, not crash reporting: a normal exit, a
  window you closed, and a process you stopped write nothing, so an empty file is
  the normal state.

## 0.1.46 — 2026-09-15

- **The network ID is shown outright.** It sat behind a "network technical
  details" disclosure, which put the one value a user opens the row to copy — the
  ID another machine joins by, and the ID support asks for — one click deeper than
  everything around it. The row now shows the label, the ID and its copy button on
  one line, with the explanation below. The account's own technical ID stays a
  disclosure; the machine's is not what this row is for.

## 0.1.45 — 2026-09-15

- **The Connect page stops asking the server a question it already has an answer
  for, and stops guessing when it does not.** Whether this machine belongs to the
  account signed in here was decided by a read that always went to the server, and
  a directory the core had not read yet came back empty — which the page read as
  the positive claim "this machine is not bound" and reported a perfectly bound
  computer as belonging to another account. It now reads the same directory every
  other page reads, and an unread snapshot is left as "not looked yet" rather than
  turned into a verdict. The page follows the core's change announcements, so the
  answer appears by itself as soon as the first read lands.
- The device-directory contract now has exactly one path: the two leftovers from
  before the core owned the directory (a per-network read and an account read that
  forced a coordinator fetch) are gone, so nothing in the interface can read the
  same list a second way and disagree with the first.

## 0.1.44 — 2026-09-15

- **A leftover workbench no longer blocks the next launch.** With a fixed port, a
  DSH Web left behind by an earlier run is supposed to be stopped and replaced —
  but the check that recognizes "this is one of ours" only matched the command
  line the way Unix renders it, and Windows renders every argument of a spawn in
  quotes. The launcher's own leftover was therefore judged a foreign program and
  the launch was refused with `runtime.port_in_use`, naming nothing the user could
  act on. Quoted and unquoted forms are now recognized alike, and a name that only
  looks similar (`…bin.js webhook`) is still refused rather than killed.
- The launcher log for that failure says what to do: the port is held by another
  process, that is usually a leftover workbench, and it can be stopped or another
  port chosen in Settings.

## 0.1.43 — 2026-09-15

- **The device list no longer reports a failure it does not have.** Opening the
  account page could show "the device list could not be read" over a list that was
  already on screen: the page asks the core to read when it opens, and that call
  could be the one that lost a race for the private channel's sixteen concurrent
  calls and came back as "busy". The page now queues its P2P calls instead of
  firing them all at once, treats a busy answer as "a read is already in flight"
  rather than as a failure, and — if a read does fail — keeps showing the rows it
  has and says so beside them, instead of replacing a list the user can see with an
  error. Opening the page also reads immediately, so the list is there without
  waiting for the next announcement or pressing anything.
- A device list that is empty in one response can no longer arrive as a null list,
  which the shell refuses as malformed.

## 0.1.42 — 2026-09-15

- **The device list now has one owner, and it keeps itself current.** A network's
  device directory is read and held by the core instead of by whichever page
  happened to open it. Each page used to read the server for itself and keep its
  own copy, so two computers in one network could show two different member lists
  and neither ever caught up — one listed only the other computer, the other only
  itself, its own row still reading "never reported", and only quitting and
  restarting the app produced the current list. Now, if this computer is already
  signed in when the app starts, its networks and their devices are **there on
  first launch** — no tab to open and nothing to refresh. The core reads the
  directory when the session is restored, after anything that changes who belongs
  to a network (registering, binding, leaving, creating or deleting a network,
  pairing), and every thirty seconds while a sign-in is active; when the content
  changes it tells the window, and every list on screen updates by itself. The new
  **Refresh list** control asks for a read right now if you would rather not wait.
- The Run tab finds paired computers by itself. The add-workbench menu reads the
  paired computers main keeps in its catalog, and only a P2P page had ever asked
  for them, so opening the Run tab first — or after a restart — showed "choose a
  LAN or SSH computer" with an empty LAN section even though the server held an
  active pair. The menu now asks for the pairs when it mounts and again every
  time it opens, so a computer paired after the app started appears without
  visiting another tab first.
- A device list read no longer loses the race with the page's other reads, and a
  directory that could not be read keeps the last rows instead of silently
  showing an empty network.

## 0.1.41 — 2026-09-15

- A first install reaches the official server. The handshake asks the coordinator
  a challenge and the shell accepts only the thirty-two character challenge shape,
  but the core had been minting that value from the id generator — which the
  twelve-character id change shortened to twelve. The shell then refused its own
  core's answer, so a new machine showed an empty server list, could not sign in,
  and was told nothing about why. The core now mints a real challenge, and the
  coordinator accepts both shapes, so a machine that has not updated yet still
  reaches it.
- A stored configuration this build cannot read is repairable from the page that
  reports it. A machine that upgraded from a release using the older identity
  scheme (ids of another length) kept a record every operation re-validates —
  including the removal of a single service — so the Connect card could neither
  read it, use it, nor drop it: it showed `p2p.catalog_invalid` beside a retry
  that could never succeed, the account page then had no server to sign in to,
  and the only way out was deleting files by hand. The card now says the record
  comes from an older release, offers to discard it, keeps both files beside the
  new one as `p2p-devices.json.legacy-<stamp>`, leaves the device key and the
  saved sign-ins alone, and provisions the built-in server again.
- The card no longer loses the failure it is reporting. The status line and the
  connections panel mount beside it, and their reads carry no service, so they
  landed in the catalog's own operation slot and overwrote a failed read with
  their success: the card then claimed nothing had been read, with no code at all.

## 0.1.40 — 2026-09-15

- A connected computer's workbench now opens. A paired computer that had
  connected successfully showed a green state and an empty page with a "connect
  first" message, because the address main held was never handed to the page that
  mounts it: the tab was waiting for a value that nothing supplied. The address is
  now asked for per connection attempt, and a tab whose attempt has been replaced
  is never handed the previous one.
- A failed connection says which side is wrong, and keeps the error code on
  screen. Every failure used to read the same, with copy that told you to retry
  the other computer's SSH tunnel — there is no tunnel between paired computers.
  The tab now distinguishes this computer not being set up, an unreachable
  coordination server, the other computer being offline, a network that cannot be
  reached, a workbench that did not start, and an authorization that is gone.
- The device id on the Connect card is this machine's real device id — the one the
  coordinator registers, the member list shows and every paired computer pins. The
  card used to show a locally generated number that identified nothing anywhere
  else, so copying it into a member list did not work. It is the same value the
  server reports for this machine, and it is available before any account is
  bound.
- A computer bound to more than one account reports its presence to the account
  signed in on it. The device identity kept naming the account the machine first
  enrolled under, so a machine that had since been added to a second account
  looked offline there while it was running, and "this computer's identity belongs
  to another account" was reported for a machine that belonged to both. The
  warning now appears only when the signed-in account's own device list — read
  from the coordinator — does not contain this machine.
- A device directory that includes a computer another account enrolled first no
  longer fails to read. The row's owning account was compared with the reader's,
  and a machine bound to two accounts carries the first one's name, so the whole
  member list was refused as a scope mismatch.

## 0.1.39 — 2026-09-15

- Identifiers are twelve characters, the length and alphabet of a hardware
  address, so a device id can be read out, typed and compared by a person. A
  device id is derived from the machine's key, which means one machine is one
  device for the life of the machine — across accounts, networks and
  re-enrollments — and the coordinator records which accounts a machine reports
  to instead of a single owner.
- The device id is shown next to the device name on the Connect card, in the
  open, with a copy button, and the network id and enrollment identifiers carry
  the same copy control instead of being selected by hand. The pairing
  fingerprint is the same twelve-character key id.
- This machine keeps one device identity. The device key was minted per
  enrollment, so every registration, every join and every re-enrollment became a
  different device: pairs, pins and catalog rows still referenced the identity
  that had just been replaced, the coordinator's list carried entries naming
  neither side of either machine, and both ends could wedge on the other's stale
  identity — the wedge the same release's other P2P fixes exist to unwind. The key
  now lives in the core's own store beside the data root, like a hardware
  address: one identity per machine, reused for every network and every account,
  and it survives losing the credential record, which is the usual way a machine
  silently became a new device.

## 0.1.38 — 2026-09-15

- A paired computer that re-enrolled no longer disappears from the other machine.
  When both devices re-enroll (each getting a new device identity), the local
  catalog still held the old pair as active, and every member sync tried to drop
  it — which the catalog's transition guard correctly refuses, wedging the sync
  on `p2p.revocation_required` forever: one machine could see the other, but not
  the reverse, and the tab never opened. A row the coordinator's list no longer
  carries is now recorded as revoked instead of dropped, so the catalog converges
  on the next sync while the loss stays visible on screen.
- Pairing survives the coordinator connection dropping. The core subscribed to the
  coordinator once, and a lost connection — a network change, a laptop sleeping, a
  coordinator restart, a half-open socket — ended the subscription for good:
  attempts and signals stopped arriving, nothing reconnected, and only restarting
  the application brought P2P back, while the shell went on showing a healthy
  device. The subscription is now supervised and re-established in-process with
  capped backoff, and a connect attempt made while it is down fails at once with
  `p2p.server_unavailable` instead of waiting out its deadline and blaming the
  transport.
- A pairing relationship whose authorization the coordinator issues again can be
  recorded again. A revoked computer is never revived by the catalog's guard, so
  re-pairing the same two devices — the repair path after a removal — could not be
  written at all and the computer stayed revoked. The revoked record is now
  retired in its own commit before the new authorization is recorded.
- A pair that names neither side of this machine no longer aborts the entire
  member sync. That leftover from a re-enrollment is skipped, so the read that
  writes pins and the catalog still runs; rejecting the whole reply for one stale
  entry is what left a machine permanently seeing only itself and answering no
  offers.
- Being removed by another device now stops the reconnect attempts. The two
  authorization refusals the core actually sends (`p2p.pair_unauthorized`,
  `p2p.network_revoked`) were missing from the terminal list, so a removed
  computer stayed listed as active and was re-attempted forever in silence.
- A runtime refusal keeps its reason. The peer handshake answered every workbench
  failure with one constant, and the management boundary then mapped every
  `runtime.*` code to `p2p.internal_error`, so "the tunnel is up but the desktop
  is not" had no readable cause anywhere. The refusal the runtime owner named now
  survives both hops.
- A workbench that died without the shell noticing is no longer reported as
  available: the owner re-reads the runtime state instead of answering from cache,
  so the peer is never handed an address that is already gone.
- The packaged smoke can no longer hang on a machine whose session is locked or
  whose desktop is disconnected. Its probes settled on renderer timers and frames,
  which such a session stops delivering, so the smoke stalled until the runner
  killed it; they now settle on microtasks and force their own layout, and every
  renderer round trip is bounded so a stall is reported where it happened.

## 0.1.37 — 2026-09-14

- A typed refusal from the core no longer kills the private channel. The frame
  decoder only admitted `p2p.*` error codes, so a refusal such as
  `runtime.port_in_use` failed decoding, closed the channel, and reached the user
  as a bare `p2p.protocol_mismatch` — taking every other core operation down with
  it until restart. The decoder now admits every family the core declares
  (`p2p.`, `managed.`, `launcher.`, `runtime.`, `remote.`), so the real reason
  surfaces and the channel survives the failure.

## 0.1.36 — 2026-09-14

- A failed sign-in, join or start now leaves the real error behind. Anything that was
  not a typed refusal collapsed into `p2p.internal_error` and the original exception was
  dropped, so a join that reached the coordinator and failed locally could not be
  diagnosed from the product. The reason is now written to `shell-diagnostics.log`
  beside the shell's own records, next to the core channel's own diagnostics.

## 0.1.35 — 2026-09-14

- The launcher now records why its private channel to the local core failed, in
  `core-diagnostics.log` next to the core's own state: the exact bytes the core sent
  for its handshake, whether the named pipe or Unix socket authenticated, what
  `core.version` answered, and the child's exit code. This is the difference between a
  core that never started and one that started and disagreed, which a bare
  `p2p.protocol_mismatch` cannot tell apart.

## 0.1.33 — 2026-09-14

- The private channel to the local core no longer closes when the core writes to
  stdout. Only the one-line handshake travels on that stream, so any other output was
  read as a protocol violation and the whole channel was dropped with
  `p2p.protocol_mismatch` — on Windows that surfaced as no device identity, no account
  state, and no way to sign in or out. Core output is now relayed only when
  `DSH_P2P_TRACE=1` is set.
- A failed core handshake now logs what the core actually answered, instead of failing
  silently, so a core that cannot start is distinguishable from one that answered
  wrongly.
- Diagnostics for the local core channel, on every platform: start the app with
  `DSH_P2P_TRACE=1` and the core's own stdout and stderr are relayed, together with the
  reason its handshake was refused. This is what identifies a core that failed to start
  instead of one that started and disagreed.

## 0.1.32 — 2026-09-14

- Devices in a network can be **removed** from the device list, and their pairs go
  with them: unbinding a device already invalidated its pairs on the server, but
  the launcher kept showing the dead pair until it happened to sync, so removing
  one device looked like it needed a second manual cleanup. The list is now
  re-recorded as soon as the removal succeeds, and the sync that does it no longer
  loses to a busy operation lock.
- A single pair can be **revoked** on its own, for when only that pairing should
  end and the device itself should stay. The warning is shown before the write,
  because revoking drops the session immediately and re-pairing never restores it.
- The device list no longer keeps rows the coordinator will **not authorize**: a
  refused member sync used to be logged and skipped, which left dead computers on
  screen (and filled the log) until something else happened to rewrite the list.
  It is now treated as the answer it is, and a transient busy lock is retried.
- A stale catalog row that named this machine as **its own peer** (an artifact of an
  older build) is dropped whenever the network catalog is rewritten, so such a row
  clears itself instead of lingering as a second, impossible "device".
- When this machine is **no longer a member** of the network you are looking at,
  the device list says so instead of leaving an unexplained gap. Removing a device
  only removes it from that network: its identity and session remain, which is why
  it can still read as online elsewhere. Revoking a device outright is a separate
  action and is not offered yet.
- The network you last chose is **remembered** (per account, on this machine
  only), so returning to the screen lands where you left instead of asking again.
  The memory never decides for you: it is used only while that network still
  exists and belongs to the same account, and only a choice you made is stored.
- A network is **selected for you when it is the only one**. The previous rule
  never selected anything, to avoid aiming an edit at the wrong network; with a
  single network there is nothing to guess, so the click is gone. Several networks
  still wait for an explicit choice and are never matched by display name.

## 0.1.31 — 2026-09-14

- The Launcher now runs **one background process** instead of two. The headless
  core that already holds your device credential and your device catalog also
  serves the whole peer protocol, so the separate peer helper is no longer
  started. Pairing, connecting and the remote workspace behave exactly as
  before; what changes is that a machine whose core cannot start reports P2P as
  unavailable rather than quietly running a second process that no longer
  exists. The preflight check now verifies the core binary the app actually uses.
- The same core now also runs **with no desktop session at all**: `dshkerd
serve` publishes its own private endpoint and answers the whole method table,
  `dshkerd dsh start|stop` runs the DSH Web child, `dshkerd status`, `pair`,
  `connect`, `proxy` and `service configure` are named commands over the same
  operations the app performs, and `call` reaches any published method with its
  refusal code printed verbatim. The app is unaffected: it still starts the core
  as its child. `npm run release:readiness` now builds the core and proves it
  answers as a headless host, and the installer workflow runs the same check on
  every platform it packages.
- The core also owns the Launcher's **own root registry** now, so there is one
  writer for the file that says where your Harness, plugins, presets and settings
  live. The file keeps its format and location, an existing install is read
  exactly as before, and a machine whose core cannot start reports its
  configuration as unavailable instead of writing it a second way.

- Your managed Harness installations are the **core's** now too. Registering a
  toolchain, cloning a Harness, switching its revision and starting it ask the core
  for one operation and keep only what it answers with, so a machine whose core
  cannot start reports these operations as unavailable instead of quietly running
  Git itself. The rules that protect a checkout — the pinned Git, the mirror, the
  worktree, and the refusal to follow a branch that moved or a tag that changed —
  live in one place instead of two, and behave exactly as before.
- Fixed a defect that stopped every **headless host** from hosting anything:
  `dshkerd dsh start` told the DSH child to read an overlay file it never created,
  so the child exited immediately (`runtime.child_crashed`) and the host had no
  address to give. The command that names the file now creates it — an empty
  overlay, the same one the desktop app writes for its own profile — while a
  patch you name yourself is left exactly as it is.

## 0.1.30 — 2026-09-14

- Paired computers are now connected **without being asked**, and stay that way.
  Connecting happens at startup for every active pair, a dropped connection is
  retried on its own (immediately at first, then with a widening delay), and waking
  the machine or regaining a network retries at once. Only losing authorization
  stops the attempts, and the refusal is kept so the reason stays visible. Switching
  between tabs never interrupts a connection: it belongs to the pair, not the view.
- A remote workspace keeps **the same address** when the connection drops and comes
  back. The gateway used to be created per connection, so every reconnect moved it to
  a new port and any browser tab left open on the old address went blank. It now
  belongs to the pair: the address survives a drop, a network change, a wake from
  sleep and even a restart of the other computer's DSH, and a tab recovers on its
  own. While no session is attached it still answers but proxies nothing. Only
  revoking the pair, or deleting its network, retires the address.
- A connection is no longer torn down by a brief interruption. WebRTC reports
  `disconnected` for a few lost packets, a changed network or a machine waking up and
  normally recovers within seconds; treating that as a failure meant every hiccup cost
  a fresh hole punch. A lost path is now given 20 seconds to recover, and a peer that
  stays away is still reported, with its reason, once that window passes.
- A reconnecting remote workspace no longer fails the moment it comes back. A message
  arriving in the instant between the connection opening and its identity being
  checked used to tear the whole connection down, which made roughly one reconnect in
  ten die immediately with “no direct path” and then quietly come back on a later
  attempt. The check now waits for itself; bytes are still only accepted once the
  peer's identity is verified.
- Your paired device credential now lives in the **native secret store behind the
  headless core** (macOS Keychain, Windows DPAPI) instead of an Electron-encrypted
  file. An existing credential from a previous version migrates itself once on first
  launch and keeps working; a core that cannot start falls back to the previous
  behavior instead of failing the app.
- Fixed a data-loss defect found during that migration: the macOS Keychain writer
  silently truncated any secret longer than 128 bytes and corrupted binary values.
  Secrets are now encoded and stored in chunks; no released version was affected.

## 0.1.29 — 2026-09-12

- A remote connection that succeeded through the **relay** no longer tears
  itself down: the selected-path check rejected any pair involving a relay
  candidate, so the first data-channel open on a relayed session was reported
  as “no direct path”. A relayed UDP pair is now accepted like any other, and
  ICE still prefers the direct path when one exists.
- Pairing signals no longer expire before they are delivered: offers and
  answers carried the lease's expiry as their own validity, which the
  receiving peer always rejected as expired. Each signal now carries a
  short, signal-scoped validity window.
- The first **two-machine session** is verified: a Mac drove the DSH Web
  runtime on a Windows host through the P2P stack over the live coordination
  server — connection, selected path, local gateway URL, and the remote DSH
  Web page loading through the tunnel.

- P2P connections now fall back to your deployment server as an **opaque relay**
  (TURN, RFC 8656) when no direct UDP path can be established. The server only
  forwards the end-to-end encrypted packet stream (DTLS/SCTP ciphertext) and can
  neither read nor inject the traffic; a network where neither a direct nor a
  relayed path works still reports `direct_unavailable`, honestly. A relay
  credential fetch that stalls (for example while the server restarts) can no
  longer stall other connections: the fetch runs outside the session lock and
  degrades to the direct path on failure.

## 0.1.28 — 2026-09-11

- A computer that is online in a shared network now appears in the Run route's
  “+ / 添加远程工作台” picker, and can be connected to. The Launcher built that
  list from the coordinator's device directory, which deliberately carries no
  device keys, so pairing was never recorded and the list stayed empty while the
  device directory showed the computer online. The list is now built from the
  pairing records, and the identifier sent to the coordinator is the remote
  device's id — the id it authorises a connection by.

- A failed remote connection now reports why. Every attempt used to be reported
  as “remote runtime unavailable”, so a network that cannot establish a direct
  path was indistinguishable from a remote machine that was not serving DSH.
  “No direct path” is now reported as such.

- Starting DSH Web no longer fails blindly when its fixed port is still held by
  a leftover DSH Web process, e.g. one left behind by an earlier crash or by a
  manual development launch. The Launcher detects the holder before spawning,
  stops a residual instance it recognizes as its own, and only refuses with a
  clear “port in use” message when another program holds the port.

## 0.1.27 — 2026-09-11

- Fixed the macOS application icon package so Finder and Applications display
  the complete multi-layer DSHKer icon instead of a broken or blurry fallback.

- Updating a managed plugin now converges its Launcher-owned clone to the
  fetched revision before checkout. Build residue can no longer brick an
  extension update or surface as a misleading core-launch failure.

- Fixed a blank Run page after the P2P security hardening. Electron 42 reports
  an omitted WebView session partition as an empty string; the strict policy
  now admits only that exact platform representation while continuing to reject
  arbitrary partition labels.

- Remote workspaces are created on demand. Run starts with Local only; click
  “+” and choose a computer from the LAN or SSH list to create and focus its
  non-closable tab. The picker is a bounded floating panel that lists ready
  workspaces first and keeps unavailable ones visible but disabled with their
  real status.
