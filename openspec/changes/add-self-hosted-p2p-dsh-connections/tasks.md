## 1. 协议与构建边界

下一步（记录，尚未实施）：目录已归 core，但**catalog 里的 computers（已配对电脑）仍由 shell 同步**
——`PeerMemberSync` 在读 `pairs.list`、给每个 active pair 重新 pin，再改写 catalog；触发点是页面
（运行页添加菜单打开时、shell 启动时）而不是 core 自己。这留下了同类的最后一个「页面触发协调器读取」
路径。收尾方案：把「读 pairs → pin → 记录 catalog computers」整段搬进 core（它已经拥有 catalog store
与 peer session 的 pin 表），按 core 自己的维护节奏执行并在内容变化时发一个 `catalog.changed` 回调；
届时 `p2pPairing.read` 的同步副作用与 `member-sync.ts`/`member-catalog.ts` 一并删除，运行页添加菜单
只读 catalog 快照，任何页面都不再触发协调器读取。难点是 `recordMembers` 的迁移规则（revoked 行先
retire 再记录、身份连续性守卫）必须在 Go 侧逐条对齐，并有对应测试。

固定端口不再被自己的遗留工作台卡死（2026-09-15，0.1.44）：端口预检本来就是「认出是自己上次启动的
DSH Web 就停掉旧的再启新的」（`PreparePortForLaunch` → `PortCleared`），但它依赖的命令行识别规则
只匹配 Unix 的渲染形式：Windows 会把 spawn 的每个参数都加引号，实际占用者是
`… apps/cli/src/bin.ts "web" "--patch" "…\verbose.patch.yml" "--no-open" "--port" "31888"`，
`bin.ts "web"` 匹配不上 `bin\.(?:j|t)s web`，于是自己被判成「外来进程」并返回
`runtime.port_in_use`；而跨私有通道只传公开 code，pid 与命令行留在 core 日志里，用户既看不到原因也
无法处理。现在两处同源规则（`networking/internal/harnessruntime/preferences.go` 与
`electron/main/managed/port-occupancy.ts`）都接受可选引号
（`(?:\bdsh\b|bin\.(?:j|t)s)["']?\s+["']?web\b`），末尾的 `\b` 保证近似名（`bin.js webhook`）
仍被判为外来而非被误杀；`electron/main/managed/launch-failure.ts` 另为 `runtime.port_in_use`
等「光看名字不知道怎么办」的 code 在启动日志里补上一句处置建议。证据：`harnessruntime_test.go`
的 `TestIsResidualDshWebCommandMatchesTheShellRule` 与 `port-occupancy.test.ts` 的
「recognizes the quoted forms the platform renders」，两者都用了事发机器上的真实命令行，以及
`launch-failure.test.ts` 三例。

设备列表不再谎报读取失败（2026-09-15，0.1.43 热修）：0.1.42 上线后账号页出现「设备列表读取失败，
请重试」，而列表其实已经拿到。两个原因：一是 main 的重复提交判重只按 `serviceId`，而读也走这道
闸，于是渲染进程按 scope（`directory` 与 `networkDevices`）分开排队的两个读在 main 侧撞车，后者
被打回 `p2p.service_busy`——现在读不再走写闸，写仍走；二是 shell 与 core 私有通道只允许 16 个并发
调用（`internal/localrpc` 由 `rpc_test.go`/`stress_test.go` 钉住的契约），启动时多个面板同时各读
一次会挤爆它并返回 `p2p.helper_busy`，落在谁头上谁就显示读取失败——现在
`P2PManagementDomain` 最多同时放行 6 个调用，其余排队，账号域把 `p2p.service_busy`/
`p2p.helper_busy` 视为「已有读取在飞」而非失败。展示规则也随之固定：**失败不覆盖已有数据**——
只有在没有任何数据时失败才占据列表位置，已有行时它只是旁边的一行提示。证据：
`p2pManagement.test.ts` 的「20 个并发调用峰值不超过 6 且全部成功」、`accounts.test.ts` 的
「重叠的目录读取不得互相判忙」、`P2PDeviceDirectory.test.ts` 的「有行时保留列表并显示提示、无行时
才显示错误」、`p2pAccounts.test.ts` 的「busy 不算读取失败」，以及真机复验（重启后打开账号页
65 秒内 `failed:false`，末次操作为 `refreshDirectory`/`directory` 且均成功）。

设备目录由 core 唯一持有并主动推送（2026-09-15）：网络设备列表此前没有 owner——协调器是权威，
但应用内每一层各留一份快照（main 每次按需去读、渲染进程按 (service, network) 缓存、组件再各读
一次），所以同一网络的两台机器各自冻结在不同时刻的回答上（一台只看到对方、另一台只看到自己，
自己那行还写着「从未上报」），刷新无效，只有退出重启才能拿到当前列表。按 `go-owned-headless-core`
既有规则（core 单一持有；每个持久化 store 只有一个 writer），目录现在归 core：
`networking/internal/helper/directory.go` 按 (service, account) 保存唯一快照，并在下列时机重读——
shell 每次带 token 的调用（core 由此得知当前会话，重启后持久会话的 `user.current` 就足以让列表
在启动时就是最新的，无需额外握手、也无需先打开任何页面）、任何可能改变成员的成功写操作
（`devices.bind/unbind`、`network.leave/join`、`networks.create/delete`、`pairs.adopt`）、以及
登录期间的 `DirectoryMaintenanceInterval`（30s，等于协调器 last_seen 的落盘粒度；读到失败时保留
上一份好快照）。内容变化才推进 revision 并发出 parent-role 回调 `directory.changed`，shell 转发给
窗口，账号 domain 只做一份投影；登出同时丢弃会话与快照，避免把一个账号的设备显示在另一个账号下。
新增 `directory.inspect`（只读快照，不访问网络）与 `directory.refresh`（先读协调器），shell 侧
`networkDevices` / `accounts.listDevices` 不再直接读协调器，只投影 core 的目录，因此“读协调器”
在应用内只剩一处。面板不再有 30 秒 tick，打开页面只读 core 的快照；“刷新列表”按钮保留并改为请
core 立刻重读。运行页方面，添加菜单读取的是 main 由 pairs 同步维护的 catalog，而只有 P2P 页面
才会触发该同步；现在菜单在挂载时与每次打开时自行 `p2pPairing.read`（既重新同步 catalog 又把它
读回渲染进程），因此先打开运行页（或重启后未访问过 P2P 页面）也能看到已配对的局域网电脑。凭据
表单另拆出 `P2PAccountAuthForm.vue`（草稿与其清理归持有秘密的组件），使 `P2PAccountPanel.vue`
回到行数预算内。证据：`networking/internal/helper/directory_test.go` 五例（快照读取与 revision
只在内容变化时推进、无会话时拒绝、带 token 的调用即开始维护、登出清空、成员写操作后重读）、
`p2pAccounts.test.ts` 的“按 core 的推送投影”、`P2PAccountPanel.test.ts` 的“打开时读 core 目录 /
刷新按钮请求 core 重读”、`P2PDeviceDirectory.test.ts` 的刷新控件两例、
`RuntimeTabsPanel.test.ts` 的“未打开任何 P2P 页面也能列出已配对电脑”，以及各自回退即变红。
实际环境已验证：在报告列表冻结的那台 Windows 上，core 的快照里两台成员都在线，100 秒内渲染进程
收到三次 `directory.changed`（每次内容真的变了才发），revision 从 3 走到 6；打开账号页无需点击
刷新即显示两行、`2 台设备 · 上限 10`、本机一行显示「刚刚」，无错误码。待办（有意保留）：
`accountDevices` / `networkDevices` 这两个旧操作现在也投影同一份 core 目录，但
`accountDevices` 仍先用 `directory.refresh` 强制读一次，因为它的返回类型无法表达「尚未读到」，
而连接卡片会把空列表当成「本机属于别的账号」；等 `p2pEnrollment.readAccountDevices` 迁到
`directory` 并处理 `known:false` 之后，这两个旧操作即可退回缓存读或直接下线。

首次安装能连服务器、旧配置可丢弃（2026-09-15）：协调器身份握手的 challenge 由 core
用 `protocol.NewID()` 生成，而十二字符 id 改造把 `NewID` 缩短成 12 字符，shell 只接受
32 字符（`assertAccountId(nonce, 32)`，注释明确 challenge 不是 id）——core 自己的回答
被 shell 判为 `p2p.invalid_request`，于是全新安装会先启用空 catalog、再加不进内置服务器，
账号页没有服务器可登录且不给原因。现在 core 用独立的 `protocol.NewNonce()`（16 字节熵）
生成 challenge，协调器对 `/v1/identity` 同时接受 32 字符与 0.1.39 仍在发出的 12 字符形式
（challenge 只被回显并签名，从不作为标识符解释）。

同一报告的第二处：旧版本写入的 catalog（32 字符 `catalogId`／64 字符 `serviceId`）在当前
版本既读不了也删不掉——inspect、commit 连 `removeService` 都会重新校验落盘记录，所以升级
上来的机器卡在既不能用也不能丢的状态，卡片只有永远失败的重试。新增显式 `resetCatalog`
（IPC `dsh-launcher:p2p:catalog-reset`）：只在记录确实读不出来或只剩一个文件时允许，把
两个文件改名为 `.legacy-<时间戳>` 后经 core 重新 enable，并把内置服务器重新写入；对能正常
读取的 catalog 以 `p2p.catalog_intact` 拒绝，因此它不可能变成静默清空。丢弃不是自动行为：
仓库规则是缺失/不可用的记录给 typed 拒绝而不是替默认值，且读不出的记录仍是用户唯一的一份。

另修一处会掩盖该失败的缺陷：`serviceSessions` 不带 `serviceId`，作用域落到了 catalog，
成功状态覆盖了 catalog 的读失败，卡片于是显示成“尚未读到配置”（无错误码）。`localDevice`、
`connections`、`serviceSessions` 现在各自拥有作用域，`#scopeOf` 同步。

证据：Go 侧断言 challenge 形状的新用例、`catalog.test.ts` 的丢弃/拒绝/首次启用三例、domain
作用域回归用例，以及在真实旧配置上经 CDP 点击丢弃：`catalogId` 变为 12 字符、`services=1`、
`p2p-devices.json.legacy-20260915-030655` 保留；线上服务器 32 字符 challenge 返回 200、12
字符仍 200、非法 400。

运行页回归修复（2026-09-10）：Electron 42 将未设置的 WebView `partition` 传入
`will-attach-webview` 时序列化为空字符串；P2P 隔离准入最初只接受 `undefined`，
因此 Local/SSH guest 在加载前被拒绝并显示白屏。现仅将该精确平台表示视为“未设置”，
继续拒绝任意手写 partition；`electron/main/security.test.ts` 覆盖两种省略形式。
该修复不改变 4.3 的多 peer 隔离验收，后者仍需真实双 App 联测。

运行页远程切页同步修复（2026-09-10）：P2P 远端成员由主进程在 `pairs` 读取时
同步到本地 catalog；启动流程和配对列表读取完成后都重新读取 catalog，确保已有配对的
局域网电脑无需先打开远程管理页就能在「运行」页的“+”列表中按需添加。没有已登记/已配对的
远端设备时仍只显示「本地」，不伪造连接或地址；`p2pNetwork.test.ts`、
`p2pPairing.test.ts` 覆盖启动和配对读取路径。

登记恢复 domain 接续：本地 pending 读回不再清除服务器结果未知；仅原 revision 的签名结果查询明确返回 enrollment_not_found 后，允许用户显式提交一次原登记请求。查询失败、服务忙、读取新 revision 和提交回复丢失均不能自动重提或生成新身份。此项仅 domain 回归，首次登记历史标记、正式登记控件与真实主进程/服务器组合验收尚未完成，3.1/5.3 保持未完成。

用户/网络界面接续：服务列表已有明确管理入口，按固定 serviceId 展示用户读取/登录/登出、网络读取/显式选择/创建/改名/确认删除。密码提交即清空，用户切换清理旧网络上下文；写结果不明保留原读回且阻止再写，只有网络列表读回解除，不能用读取用户清掉不确定状态。补修 main 在明确会话未授权后清掉原服务会话以允许重新登录，普通断网不清除。相关 30 项 main/domain/组件诊断通过；真实两 App、全控件布局/键盘及设备登记/配对/工作台仍未完成，D62/D63/5.3 不提前勾选。

Renderer 接续：增加 remote-connections 的共享 P2P domain owner，以及正式远程页服务管理区。可显式启用、读取、输入全部端点并验证添加；typed 中英文文案区分未加载/失败/未启用/已保存，不显示假连接状态。文档序号跨组件保留，服务级 pending 隔离，取消等待原结果，未知写结果不重发；草稿保留且不进入操作状态秘密。新增 domain/组件诊断用例 11 项通过；尚缺真实 UI 尺寸/输入轨迹、完整用户网络/登记配对控件和双 App 验收，5.2/5.3/5.9 不提前完成。

管理 IPC 接续：正式 main 注册 15 项版本化 named IPC，冻结 preload 能力包含启用/公开目录/服务添加、用户与网络管理、登记/恢复及同页面取消。字段、顶层 sender、请求序号/并发预算和页面退役准入均在 main；已接受写入取消或超时返回结果未确认，公开 projection 排除证书/秘密/运行地址。新增准入、请求生命周期、projection 与生产 preload 测试共 46 项通过，类型/架构/Electron 构建通过；完整回归 113 文件/775 项通过。完整 Go race 亦通过，integration 195.448 秒。domain/UI/完整配对和双 App 尚未完成，不提前勾选 5.2/5.3。

正式管理组合接续：`electron/main.ts` 已创建 `PeerManagement`，实际拥有 catalog/安全存储/helper/服务/账号/登记编排；helper 故障清空账户与登记 owner。网络删除确认后调用真实 `network.invalidate` 并持久化同网络电脑的 revoked 状态；Go 清理 pins/保留中的 session 并等待释放，保留网络/配对 tombstone 防复活。控制器/host/退出相关 27 项、完整应用 729 项、类型/架构/构建通过。IPC/preload/UI 与双完整 App 仍未接通，不提前完成 5.2/5.3/7.8。

登记编排接续：新增 `PeerEnrollment`，串接服务信任、账户/网络准入、加密待登记保存、原 CSR、登记及独立结果查询，三处身份读回一致后才报告完成。恢复查询不自动消费新凭据；显式重提保留原 key/request。17 项契约测试覆盖持久化失败、回复不明、身份冲突、并发/取消/关闭迟到结果。正式 controller/IPC/UI 及该 TS 流程的真实服务器集成尚未接通，3.1/5.2/5.3 保持未完成。

原密钥登记准入接续：新增 main/helper `device.createCSR`，校验已保存 Ed25519 key 的 seed/public 一致性，不生成替代身份；真实 helper 的 8 个原 CSR 读回及关闭/取消准入通过。main 账户层新增原用户/网络归属约束的登记 grant 获取，拒绝身份变更、错网络和过期结果（新增 5 项测试）。尚未接通完整登记编排及 UI，不提前完成 3.1/5.3。

登记恢复接续：客户端/helper 已接现有服务器签名登记查询；原请求/密钥可独立读回，真实 server 重启后身份/证书不变，错误 key/request 被拒绝且无重复设备。全 Go race 回归通过（integration 187.565 秒）。main 安全存储新增待登记→正式凭据的同文件原子转换和显式状态读取，14 项 schema 单测及真实两 Electron 进程加密/重启/身份冲突诊断通过。尚需正式登记编排、原 key 的 CSR 重建、结果不明 UI 和实际回复丢失注入；3.1/5.3 不提前勾选。

主进程组合接续：`electron/main.ts` 已创建正式 `PeerRuntimeHost`，使用登记 settings root、实际受管 runtime 和明确的开发/打包资源根；显式启用后才启动 helper。回调重新校验服务/配对/状态，拒绝旧代次和已退役 URL，运行时失效调用真实 helper manager；失效清理失败停用 P2P，不回退传输。退出组合尝试全部所有者清理并保留所有错误。相关单测 111 项通过，真实 Go helper + 实际 runtime owner 诊断通过，未启动 DSH 工作台。IPC/UI、登记恢复与显式 helper 重启编排仍待实现；任务不提前勾选。

正式运行源接入接续：为既有 `LauncherHarnessService` 新增 main-only launch 快照/事件，P2P runtime owner 据真实公告分配/退役 generation、合并冷启动和独立取消，保留具体启动前置错误。新增服务目录→helper 的身份验证/保存/重开准入，拒绝旧 revision、端点/身份替换及忘记后的缓存复用。新增服务与运行时测试 18 项，相关 140 项通过；完整应用单测 104 文件/665 项通过（使用规范 TMPDIR），类型/架构/源码长度 47 文件通过。正式 main/helper/IPC/preload/UI 组合尚未完成，相关任务不勾选；本次结果不能替代完整联测。

账户业务接续：新增 main-only `PeerAccounts` 登录/当前用户/登出及网络列举/创建/改名/删除编排，令牌仅驻留内存，按服务隔离操作锁，写后按网络/用户身份读回，删除确认后调用必需的授权清理回调。14 项 test-only RPC 契约测试通过，P2P 子集共 70 项、type-check、architecture:check、42 文件长度门禁通过。该层尚未接入正式 main/preload/UI，也未做该 TypeScript 编排与真实服务器的端到端验证；5.2/5.3/D62/D63 不提前完成。

完整 Go 回归接续：使用显式真实 server 二进制及受管 Harness，`go test -race -count=1 -timeout 8m ./...` 全部通过，integration 用时 186.703 秒，原重连资源阈值未修改。P2P TypeScript 子集 56 项通过，源码长度检查 39 文件无超限。该结果更新 Go 层回归证据，不替代双完整 App、1 小时工作台压力、完整交互清单或平台打包门禁。

Helper 清理接续：修复子进程强杀后 Unix socket 残留导致目录删除失败，以及退出后未自动执行完整本地清理的问题；启动认证后再次校验取消。新增精确 Windows 管道名称合约、真实测试 socket 子进程强杀和非 socket/额外文件保留测试（4 项通过），重建 macOS arm64 Go helper 并通过生产 supervisor 的并发 RPC/取消/退出诊断。尚无 Windows 管道实跑及双完整 App 故障恢复证据，3.5/7.8 保持未完成。

目录持久化接续：新增 main-only catalog 的显式启用/标记身份、严格 schema、原子提交与读回、revision 冲突和输入快照；补齐固定配对身份、撤销不回退及 tombstone 先于删除的存储准入。新增 27 项真实临时文件/模式测试，加原 RPC/wire 共 52 项 focused 测试通过，type-check 与 architecture:check 通过。尚未接入 named IPC、完整主进程业务及 UI，5.1/5.2 不据此完成，完整回归与发布门禁仍待执行。

安全存储与管理客户端接续：真实 Electron macOS safeStorage 在两个独立进程中完成加密保存/重启读回/删除，拒绝重复创建、旧 revision、错误密钥、损坏格式，落盘不包含明文私钥。初次写入改为同步完整临时密文后排他发布。新增 Go 用户/网络/绑定管理命名操作，真实服务器 readback 验证通过；只新增客户端 API，不改独立 server 架构或提交历史。尚缺业务 catalog、UI/正式 app composition 和 Windows DPAPI，任务不提前勾选。

Electron helper 接入进展：主进程私有 RPC、严格 JSON framing、固定资源摘要校验、stdin 随机秘密和 Unix/named-pipe 认证已形成独立模块（该通道现由 Go 核心持有，shell 只是它的一个客户端，见 go-owned-headless-core P1/P2）；真实 Go helper 诊断通过 8 次并发设备密钥生成、错误字段拒绝、取消准入和退出确认，25 项协议/RPC 单测及类型检查通过。新增 safeStorage 凭据模块尚待真实系统安全存储与服务登记/忘记流程集成验证。（后续：凭据存储已迁入 Go 核心，见 go-owned-headless-core P2，Electron safeStorage 不再是所有者。）未接入正式 app composition、未完成打包资源和 UI；3.1/3.5 不勾选。完整 workspace validator 仍有文档机器路径、生成二进制及协议正则/管道字符串的路径检查发现，未将其标绿。

生命周期接续（2026-09-07）：建立请求从 Begin 前即持有可取消 session；Disconnect/Close 等待 gateway、mux、transport、续租及会话占用清理，目标 runtime invalidate 拒绝迟到 owner 凭据，失败终态不再立即覆盖为 disconnected。新增真实独立 coordinator + 两个生产 Go manager + 隔离真实 DSH 诊断，验证 5 次显式重连、真实 DSH 重启、新 runtime generation、旧入口关闭和 manager 退出后 DSH 继续可用。该诊断未启动两个 Electron App，不据此完成 3.5/4.1/5.10/7.8；命令与证据边界见 `docs/testing/p2p-runtime-session.md`。

Helper 接入进展（2026-09-07）：新增 Go helper、私有 RPC、runtime HTTP/WS gateway 与 session manager 的生产模块；修复 RPC 并发编号乱序、认证预读丢字节、连接 deadline 并发、gateway 关闭竞争及公钥类型比较错误。focused race 测试覆盖双向 800 次 RPC、错误密钥、协议拒绝、身份替换拒绝和 Pion 上 HTTP/WS 转发；Windows x64 helper 交叉编译仅作为编译证据。尚缺 Electron supervisor/安全持久化/UI/真实受管 DSH 生产组合及完整压力门禁，3.5、4.1、4.2 和发布任务不据此勾选。详见 `.agents/notes/2026-09-07-p2p-helper-integration.md`。

连接状态分层（2026-09-10）：远程连接状态拆为两层并各有单一来源。网络会话（本机↔协调服务器）在 main 记录、经 `serviceSessions` 暴露、变化时推送、每 60 秒仅重试非在线服务、运行时失效即标记离线并附拒绝码；shell 启动即读取，状态栏在所有路由显示。配对连接（本机↔某台电脑）投影到 runtime tab，peer 与 SSH 对等且均不含地址（DSH 入口留在 main）。修正 Connect tab 用配对阶段回答网络状态的缺陷：单机零配对时 `ready` 结构性不可达，导致设备目录显示在线而该卡片显示离线。两层均区分「未读取」与「已确认否」,吊销配对报 disconnected 而非 failed。订阅以独立参数传入 IPC 注册（挂在 owner 上会破坏 79 项准入测试的不变量）。1187 项测试、类型/格式/架构/visual-smoke/构建通过；单机环境无法证明配对达到 ready，不据此勾选 4.4/5.4。详见 `.agents/notes/2026-09-10-p2p-connection-state-layers.md`。

预发布顺序修订（用户已明确确认）：先完成实现、本地生产组合端到端、安全和包门禁，发布 GitHub prerelease 供 Win/Mac 联测；不进入 latest/稳定源。物理平台与公网矩阵在候选发布后执行，相关任务不提前勾选；7.9 继续约束正式稳定版。新增 9.3 追踪联测预发布，不能借此跳过缺失实现或本地门禁。

扩展授权修订：用户已明确要求继续补齐客户端扩展。扩展归属 Launcher 独立包，不需要改写用户受管 Harness 源码；按第 9 节继续实现，替代下面历史记录中的“等待所有权确认”。

客户端扩展验证：9.1 的 16 项模块/准入测试通过；针对实际选定 Harness `a66e4702047846cdaa10c66c9d3df3951f5ea70d`，隔离真实 DSH + Electron 通过插件加载、导航读回、新会话切换、重载重新注册、错误路径拒绝且选择不变。命令与限制记录于 `docs/testing/remote-workbench-api-audit.md` 和 Agent Note。只完成独立扩展任务，不代表 9.2 正式产品接入或整项发布验收。

2026-09-07 继续实施记录：新增生产流复用、固定 credit 环形缓冲与半关闭模块及真实 Pion 通道诊断测试，属于 3.4 的局部实现；未完成跨平台压力、helper 和 DSH 集成，仍不勾选。1.4 源码审计核对实际选定版本与 HTTP/WS/工程/会话 API，发现指定 guest 会话导航与确认的客户端契约缺口，详见 `docs/testing/remote-workbench-api-audit.md`；对应 4.7/5.10 等待客户端扩展所有权及兼容方案确认，不能用脚本注入替代。

执行修订（2026-09-07）：用户已授权优化后实施。先交付可独立验证的 Go 身份/协议/服务基础与 SSH 编辑纵向链路，再接 P2P helper、受管 DSH 和完整 UI。真实部署/物理机证明仍为最终关卡，不阻止本地协议及生产模块实现。任务未满足所有声明层级前保持未勾选，局部结果记在 Agent Note。

本地压力验证修订（2026-09-07）：按用户最新要求，本阶段不发布；使用独立服务器真实二进制与两个独立 OS 测试进程，调用生产 controlplane/peer 包。新增 `networking/integration/` 中的连接、128 MiB 双向传输、30 次显式重连、90 秒真实续租、服务/peer 强杀、撤销与慢接收端预算测试。它不是 Electron helper、DSH HTTP/WS、跨物理机 NAT 或 Windows 验收。具体命令及限制见 `docs/testing/p2p-local-stability.md`，完整功能任务仍保持未完成。

完整交付修订（2026-09-07，覆盖上段阶段性不发布约束）：用户已确认完整远程工作台范围，并授权更新、实现、质量验收后发布。新增远端授权根/目录选择/工程打开、原生 DSH 工作与任务恢复，严禁把底层诊断作为成品。正式发布新增 7.9，必须等待全部依赖与 quality-engineering verify；尚未取得的目标机器/部署输入不能猜测或用本机模拟替代。

- [ ] 1.1 建立只含 peer 与协议的 `networking/` Go module，固定 Go/Pion 版本及许可证清单；server/admin 由独立 `ankye/dshker-server` 构建。Owner: networking；依赖: 本提案；验证: 锁文件可复现、`go test ./...` 与依赖图检查通过，macOS/Windows peer 可交叉编译且不引入 ZeroTier 或生产 fake。
- [ ] 1.2 实现严格信令 envelope、规范签名编码、attempt/generation 校验及有界帧协议。Owner: networking protocol；依赖: 1.1；验证: golden 编码、未知字段/版本、过期、重放、跨 attempt 和畸形长度测试在 macOS/Windows 通过。
- [ ] 1.3 定义版本化 main/helper 合约及新增 typed IPC schema，明确登记凭证准入、状态 projection 和 secret 排除。Owner: Electron/shared；依赖: 1.2；验证: schema/admission 单测覆盖允许操作、未知字段、非法 sender 和机密字段；两平台使用同一合约。
- [ ] 1.4 审计所支持 DSH 版本的原生目录选择、工程/会话打开、任务查询/停止及 HTTP/WS API，记录源码位置和真实读回证据，再确定命名工程合约。Owner: Electron/runtime；依赖: 已批准范围；验证: 每个必需能力有准确版本/接口/身份/权限说明，不虚构 API；需要 Harness 修改时先补齐跨仓所有权及兼容任务，缺口阻止后续对应实现。

## 2. Go 协调服务器（独立仓库依赖）

用户最新边界：本节与 6.1 的实现转由独立 `ankye/dshker-server` / `add-dshker-user-networks` 所有；保留以下编号作为客户端联调依赖，不在 DSHKer 重复实现或声称已完成。服务器新增用户隔离、Gin、网络创建/删除与设备绑定，客户端 5.3 必须覆盖登录、网络管理、绑定/解绑操作。不得耦合 NetHopper/OneIsland/NATS。`networking/` 只保留 peer 和协议，服务器/admin 不在其中构建。

- [ ] 2.1 实现显式配置、init、SQLite 事务及持久签发身份。Owner: coordinator；依赖: 1.1；验证: Linux 服务 init/重启/匹配备份恢复通过，缺配置、坏数据库、缺密钥及错误 schema 明确失败且不覆盖状态。
- [ ] 2.2 实现本地 admin 单次登记凭证、CSR 持有证明与设备 mTLS 登记。Owner: coordinator/auth；依赖: 1.2、2.1；验证: 并发消费仅一次成功，过期/伪造/重用拒绝；macOS/Windows 客户端认证合约测试通过，日志不含凭证。
- [ ] 2.3 实现邀请、目标批准、发起端指纹确认、固定公钥及关系级访问控制。Owner: coordinator/pairing；依赖: 2.2；验证: 两设备完整配对通过，未批准、邀请过期、跨关系查询及身份替换被拒绝。
- [ ] 2.4 实现 WSS 信令、同一设备对的原子 attempt 占用、限流及元数据审计。Owner: coordinator/signaling；依赖: 1.2、2.3；验证: 双向有效信令通过，并发拨号返回 busy；超限/重放/伪造 sender 不转发，DSH payload 不进入信令或日志。
- [ ] 2.5 实现独立 UDP STUN Binding 及报文/来源/全局预算。Owner: coordinator/stun；依赖: 2.1；验证: 真实 UDP 请求返回实际源地址，未知方法、TURN Allocate 和超限被拒绝；HTTPS 正常而 UDP 被禁时分别报告状态。
- [ ] 2.6 实现在线心跳、60 秒授权租约、20 秒续期、持久撤销和服务重启恢复。Owner: coordinator/auth；依赖: 2.3、2.4；验证: 假时钟边界单测与真实两客户端检查证明 30 秒 stale、立即撤销/到期关闭及重启不恢复过期在线状态。
- [ ] 2.7 实现受限管理查询、申请拒绝/最终状态读取、登记结果持有证明查询，以及新端点的服务签名身份说明。Owner: coordinator/auth；依赖: 2.2、2.3、2.6；验证: 仅返回本机所属结果，过期/并发处理正确，挑战/签名/端点不匹配拒绝，macOS/Windows 换地址前不泄露旧凭据。

## 3. DSHKer 内置 Go peer

- [ ] 3.1 实现本地设备密钥生成及 main 侧 OS 安全存储，登记客户端使用正常 TLS 校验和 mTLS。Owner: Electron security + peer；依赖: 1.3、2.2；验证: macOS Keychain/Windows DPAPI 持久重启通过，安全存储不可用明确失败；renderer、argv、日志和服务端均无私钥。
- [ ] 3.2 实现 peer 配对确认、固定身份、WSS 协商及本地授权租约执行。Owner: peer/auth；依赖: 2.3、2.4、2.6、3.1；验证: macOS/Windows 协议测试覆盖撤销、换钥、服务中断和旧 generation，DSH 业务必须等待授权。
- [ ] 3.3 实现 Pion UDP ICE、设备签名 SDP/候选绑定及实际 DTLS fingerprint 准入。Owner: peer/transport；依赖: 1.2、2.5、3.2；验证: 两独立物理 peer 最小直连记录非 relay candidate pair，篡改协商失败；TURN/公共 STUN/SSH/WSS 中继不可启用。（2026-09-12 更新：自部署 TURN 中继回退由 11.4/11.8 按用户决定引入，relay 选中对为合法路径；公共 STUN/SSH/WSS 中继仍不可启用。）
- [ ] 3.4 实现可靠 DataChannel 流复用、FIN/RESET、credit 背压与帧/stream/队列预算。Owner: peer/transport；依赖: 3.3；验证: 大小边界、慢读、半关闭、并发流和跨 generation 注入测试通过，macOS/Windows 压力测试无无界队列或资源泄漏。
- [ ] 3.5 实现 main 监督 Go helper、Unix socket/Windows named pipe 隔离及启动握手。Owner: Electron p2p；依赖: 1.3、3.4；验证: 两平台取消、崩溃、退出及错误版本测试通过；缺 helper 不启动替代程序，无 TCP 管理入口。

## 4. 受管 DSH 数据通道

- [ ] 4.1 接入受管 runtime 的 start/state/invalidate，绑定实际启动 URL 和 runtime generation。Owner: Electron runtime/p2p；依赖: 3.5；验证: macOS/Windows 上运行中改设置仍用旧端口，重启后旧 Token/stream 失效；缺根/profile/工具、未知版本及脏状态沿用具体本地错误。
- [ ] 4.2 实现只指向当前受管 DSH 的 loopback HTTP/WS adapter。Owner: Electron p2p + peer；依赖: 3.4、4.1；验证: 真实 DSH 认证 HTTP、Cookie、重定向及 WebSocket 通过，Host/Origin/CONNECT/任意目标注入失败；保留路径和查询语义。
- [ ] 4.3 为 Local 与每个 peer 隔离 browser session partition，通过 main 将本地入口交给受限 Run guest。Owner: Electron browser；依赖: 4.2；验证: 至少 Local + 两个 peer 的 Cookie/Token 互不串用，普通 renderer projection 无原始远端 URL，断开后旧入口不可用。

  实施边界（2026-09-15）：入口地址按 attempt（generation）经命名操作 `entry` 单独交给渲染进程，projection/status 仍不含地址；渲染进程确实会拿到带 token 的 loopback 网关 URL，因为 `<webview>` 只能挂真实 http URL，而主进程自建 scheme 无法承载 DSH Web 自身的 WebSocket 升级。隔离由该 pair 的 guest partition 保证，理由与取舍见 `docs/p2p-connections.md` 的 “The peer workbench address”。把 guest 搬进主进程（`WebContentsView`）可让 token 完全不进渲染进程，见 4.9。
- [ ] 4.4 实现阶段化连接状态、超时/取消、testStatus 与 live 状态分离及统一 generation 清理。Owner: Electron p2p；依赖: 4.2、4.3；验证: 测试包含真实 HTTP/WS 后销毁临时链路，Connect 才保留 ready；重复、旧回调、撤销、崩溃和退出均不污染其他连接。
- [ ] 4.5 实现远端用户授权根的选择/持久化/读回/撤销，以及绑定配对的命名根列表/目录分页能力。Owner: Electron/remote-projects；依赖: 1.3、1.4、3.5、5.1；验证: 无隐含整盘授权，真实目录列表精确匹配；缺授权/权限/目录错误分别反馈，撤销拒绝旧引用，控制面不承载工程数据。
- [ ] 4.6 实现目标系统路径规范化、实际根包含关系验证、不透明引用和操作时重检。Owner: Electron/remote-projects；依赖: 4.5；验证: Windows 盘符/大小写/保留名、Unicode、symlink/junction、遍历、目录替换、未授权 UNC、跨 peer/root/generation 注入逐项拒绝或准确读回，不扩大文件访问能力。
- [ ] 4.7 经已验证 DSH 原生契约完成工程打开、结果查询及工程/会话身份映射。Owner: Electron/runtime + domain；依赖: 1.4、4.2、4.6；验证: 真正打开远端工程后再成功，丢回复读回原请求，不重复创建，不替换成本机同名目录；原生权限审批不绕过。
- [ ] 4.8 接通真实 DSH 工作与断线任务核对，区分连接丢失/任务停止/结果未知。Owner: runtime/browser/domain；依赖: 4.3、4.4、4.7；验证: 经公开 UI 读取、修改隔离远端文件并执行验证任务，独立远端内容/任务读回一致、本机不变；断线/重连/重启均不自动重放操作，不伪造任务状态。
- [ ] 4.9 把 peer 与 Local guest 改为主进程持有的 `WebContentsView`，使入口 URL（含 token）完全不进入渲染进程；渲染进程只上报占位区域并接收构造/缩放/销毁指令。Owner: Electron browser；依赖: 4.3；验证: 渲染进程内存中不存在带 token 的地址，Run 页的后退/前进/刷新/缩放/渲染指标与视觉冒烟与当前 `<webview>` 实现等价；每对设备仍使用各自 partition。

## 5. 多电脑界面与持久记录

- [ ] 5.1 实现已登记 settings root 下严格版本化的 P2P catalog，独立保存服务与配对记录。Owner: Electron persistence；依赖: 1.3、3.1；验证: 显式首次启用、重启、损坏/缺失已登记记录及未知版本测试通过；启用 P2P 不改 SSH catalog，明确 SSH 编辑仅修改选定记录且保持原格式。
- [ ] 5.2 接通新增 named IPC、preload 冻结能力与 remote-connections domain adapter。Owner: Electron/preload + renderer domain；依赖: 4.4、5.1；验证: 每项操作有正反 admission 测试，renderer 无文件/进程/任意网络能力，类型与架构检查通过。
- [ ] 5.3 在远程 Tab 增加 P2P 服务配置/分项检查、本机登记、设备邀请/批准/拒绝/指纹确认与撤销 UI。Owner: renderer remote-connections；依赖: 2.7、5.2；验证: macOS/Windows 可完成全流程，重开页面读回准确申请/授权状态，所有文案走 typed locale，无私钥复制或未知设备静默授权。
- [ ] 5.4 显示 presence、红绿连接状态、阶段与测试结果，启动仅保持一个 Local；用户通过“+”显式创建每台电脑的不可关闭 tab。Owner: renderer shell；依赖: 5.3；验证: 窄窗口和常规窗口可读，状态不只依赖颜色；启动不挂载未选择的电脑，按需添加/离线/测试成功/真实连接/移除选中电脑等场景及 Local/SSH 回归通过。
- [ ] 5.5 实现 SSH 原子编辑和 P2P 本地名称更新，以及 configRevision 准入和记录级并发锁。Owner: Electron remote/persistence；依赖: 5.1、5.2；验证: 名称修改不断流，参数变更先断开，保存失败/旧 revision/已移除目标不部分覆盖；读回持久文件并验证原格式与其他记录不变。
- [ ] 5.6 实现共享 P2P 服务器配置编辑、影响集合锁和同服务身份/端点验证。Owner: Electron p2p；依赖: 2.7、5.5；验证: 任一关联电脑 busy 即拒绝，正常新地址成功保存、旧测试失效，不同服务身份不收到旧凭据，失败保持原配置且不自动重连。
- [ ] 5.7 实现统一编辑面板的预填、字段差异、保存/取消、脏草稿关闭确认、结果不明读回和冲突反馈。Owner: renderer remote-connections；依赖: 5.5、5.6；验证: SSH/P2P 全字段正反用例、指针/键盘/焦点、并发/迟到结果均通过，失败保留输入，登记秘密不当普通草稿保存。
- [ ] 5.8 接通 Run 断线页的连接/重试/编辑入口、打开已创建标签及名称同步，完善撤销后移除的部分成功状态。Owner: renderer shell + Electron lifecycle；依赖: 5.4、5.7；验证: 入口定位同一记录、改名不重载、旧 URL 不加载、撤销成功但删除失败保持 revoked，不影响 Local/其他电脑。
- [ ] 5.9 实施远程页/编辑区/Run 断线页完整交互与布局验收。Owner: QA/UI；依赖: 5.7、5.8、6.2、6.3、7.1、7.2；验证: 第 8 节全部界面用例有自动化断言及真实 UI 操作证据，760×560、常规窗口和现有小高度 smoke 均可操作，中英文长文案、焦点与减弱动态效果无遗漏；按依赖图执行，不提前启动 candidate E2E。
- [ ] 5.10 实现远端授权根管理和连接方目录/工程选择 UI，已创建的标签持续显示电脑/工程/会话归属与任务待确认状态。Owner: renderer/remote-projects；依赖: 4.5–4.8、5.2、5.4；验证: 面包屑/上级/刷新/分页/选择/取消、既有工程入口、空/加载/权限/失效状态、键盘/焦点/长路径/中英文均具真实入口，不使用本机原生目录弹窗冒充远端。5.9 与 7.2 同时要求本任务完成。

## 6. 部署与原生交付准备

- [ ] 6.1 增加 Linux amd64/arm64 server/admin 独立构建、Docker/systemd 模板及 HTTPS/WSS/UDP 分项健康检查。Owner: release/server；依赖: 2.1–2.6；验证: 干净 Linux 环境可按文档 init、启动、重启及恢复；配置/证书缺失明确退出，制品不含真实凭证。
- [ ] 6.2 在取得用户明确的服务器地址、架构和证书部署输入后部署验收服务。Owner: server operations；依赖: 6.1；验证: 记录实际部署版本、配置字段完整性、TLS 信任及公网 UDP 可达证据，macOS/Windows 均可登记；未提供环境时保持任务未完成。
- [ ] 6.3 将匹配的 Go peer 纳入四种桌面架构的固定资源路径及哈希/版本检查。Owner: release/desktop；依赖: 3.5；验证: macOS arm64/x64、Windows x64/arm64 制品逐个核对架构并实际启动/停止 helper；桌面包无 server/admin、ZeroTier 或测试 composition。
- [ ] 6.4 编写用户配置/配对/编辑/撤销/错误排查及服务器升级备份说明，更新中英文 README 功能入口。Owner: documentation；依赖: 5.8、6.1；验证: 根据实装 UI/命令复现，明确共享配置影响及保存/测试/连接的区别，不声称全 NAT 必通，也不将安装包构建等同于发布成功。

## 7. 完整测试实现、跨机器验收与完成关卡

- [ ] 7.1 在实现阶段建立 `test-gates/add-self-hosted-p2p-dsh-connections.json` 与交互合约，逐项绑定第 8 节用例、全部生产改动文件、真实字段来源、身份键、执行命令和原始证据。Owner: QA/integration；依赖: 1.3；验证: 清单无漏项/重复 ID，风险为 interactive，规划阶段不得标记 implementation_complete；架构、依赖隔离、删除审计、文件长度、focused tests、build、strict specification 前置证据完整后才启用 candidate E2E。
- [ ] 7.2 实现第 8 节服务、协议、IPC、持久化及 UI 状态的自动化测试，失败输入、参数边界和故障注入逐项展开。Owner: QA + 各模块实现者；依赖: 2.7、4.4、5.7、5.8、7.1；验证: 每个用例对应可运行测试名和明确断言，写入必须读回，六类状态及 config/attempt/runtime identity 均有覆盖，生产无测试注入入口。
- [ ] 7.3 在真实 Windows↔macOS 双向矩阵上验证配对、编辑、连接、非默认 DSH 端口、HTTP/WS、隔离标签和清理，覆盖全部四种支持架构。Owner: QA/native；依赖: 5.9、6.2、6.3、7.2；验证: 每个样本记录不同物理机器/device identity、版本/架构、selected candidate pair 和真实应用结果；本机自连不可替代。
- [ ] 7.4 验证同 LAN、不同 NAT、IPv6、禁止 UDP 和无法直连网络。Owner: QA/network；依赖: 7.3；验证: 成功样本有客户端直传流量证据，失败样本报告 `direct_unavailable`；服务端只有允许的控制/STUN 流量，绝无隐式中继。
- [ ] 7.5 执行撤销/租约过期、服务器重启、peer/helper 崩溃、Token 轮换、密钥变更、并发编辑/测试/连接和取消的跨平台故障矩阵。Owner: QA/security；依赖: 7.3；验证: 第 8 节故障点全部有独立结果，旧 generation 失效，无残留监听/进程/凭证、无假绿色，Local 与其他 peer 保持原状。
- [ ] 7.6 运行 Go 测试/race、仓库 environment/format/architecture/type-check、完整单测、service/visual smoke、Web/Electron build 及 workspace desktop-app validator。Owner: integration；依赖: 7.3–7.5；验证: 第 8 节命令逐项记录，不以 focused 代替完整套件；补跑既有 Harness 注册/激活/脏状态拒绝和 Local/SSH 回归，相关失败未解决时不得标记完成。
- [ ] 7.7 更新 Agent Note、执行 OpenSpec strict validation 及 test-integrity/交互原始 ledger 的 verify，整理四架构 packaged smoke/依赖与制品扫描证据。Owner: integration/release；依赖: 6.4、7.6、7.8；验证: 所有规格场景到用例/断言/原始结果可追踪，无未执行/跳过/缺设备证据项；static 检查、截图或编译不能替代真实验收。
- [ ] 7.8 完成真实打包 App 的远端工作台 E2E 与至少 1 小时持续压力、多个 peer/并发 HTTP+WS/慢读/故障恢复测试。Owner: QA/native/security；依赖: 4.8、5.10、6.3、7.2；验证: D48–D61 独立原始记录、文件/任务 oracle、全控件交互 ledger、资源回归；普通慢读通过 credit 恢复而不是把整 peer 队列保护断开算成功，原 90 秒 Go 测试不替代本任务。
- [ ] 7.9 在完整验收通过后提交归属明确的修改、推送并发布正式 Release。Owner: release；依赖: 7.3–7.8；验证: 干净候选包含已提交完整 manifest，版本/标签/提交一致，四原生 CI 与 publish job 成功，实际 Release API/资源读回与包身份一致；无关脏改动、秘密和生成证据不混入提交；任一缺实现/缺设备/缺门禁证据保持 not ready。

## 8. 完整测试用例与追踪

### 8.1 执行约定与平台矩阵

以下是待实现、待执行的验收用例，不是已通过报告。**本节所有用例初始状态统一为 NOT_RUN。** 每个表格行及其参数展开项都须保留独立结果，不可只执行一个代表值后宣称整行通过。新增/修改规格场景时同步增补，禁止 `.only`、skip、空断言或仅检查 HTTP 200/数组长度。

- A：自动化契约/状态测试（Go、Vitest）；test-only composition 中允许可控时钟和故障注入，不进入生产。
- I：生产模块集成与真实 SQLite/文件/OS 凭证存储读回；隔离测试目录，不操作用户原数据。
- R：两台不同物理机器、真实 coordinator/peer/DSH 及公开 UI 控件端到端；内部调用、自连、mock server、截图单独不能替代。
- P：最终原生制品的架构/依赖/资源/进程检查与 packaged smoke。
- 标为多层级时全部必需。服务器 A/I 在 Linux amd64/arm64 执行；客户端 A/I/R/P 覆盖 macOS arm64/x64、Windows x64/arm64，涉及 Keychain/DPAPI 必须在所属系统实测。
- 跨机基础矩阵为两种 Mac 架构 × 两种 Windows 架构 × 双向发起（8 个方向），逐项跑登记配对、名称/连接配置编辑、非默认端口、HTTP/WS、按需打开标签、断开和进程清理。
- 上述 8 个方向的传输核心用例再交叉同 LAN、不同公网 NAT、原生 IPv6、禁止 UDP、受控无法打洞五种网络；后两种预期失败。记录真实拓扑，无法取得的设备/网络为 BLOCKED，不能用模拟或另一架构顶替。
- UI 在四架构上验证生产最小窗口 760×560、常规 1240×820，以及既有 420 高度 smoke 特例；覆盖中英文、长名称/地址/错误、鼠标、键盘与减少动态效果。420 为 smoke 特例，不改变生产最小尺寸。

执行记录必须包含 `caseId + variant + runId`、源码/制品版本、两端物理设备与架构、输入来源、脱敏的 deviceId/connectionId/pairId、configRevision、attemptId/generation/runtime generation、前后状态、预期/实际、命令/测试名、退出码、日志/ledger/网络路径证据和 PASS/FAIL/BLOCKED/NOT_RUN。身份键不适用时说明原因，不能借省略键掩盖串线。真实 Token、私钥、完整 SDP/ICE 凭证不得写入报告。

每条写入同时断言 UI 值、API projection 和持久记录读回；每条失败同时断言未改变字段、其他电脑/Local 不变、无新增授权/残留 socket/进程。交互 ledger 经公开按钮记录 ready/accepted/pending/outcome/settled 与焦点/可见状态，不能把 pending 当成功；网络端到端预算沿用 design 的阶段预算，不通过延长 timeout 或放宽已锁定阈值让测试变绿。

### 8.2 Go 协调服务用例（C）

用例名称与 `self-hosted-peer-coordination` 的 Scenario 精确对应。

| ID / Scenario                                               | 前置条件与操作                                                              | 预期结果与读回断言                                                                | 层级  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----- |
| C01 `Start a configured server`                             | 隔离 Linux 实例；显式 init 后提供完整 TLS/端点/状态路径并启动               | HTTPS/WSS/UDP 分项就绪；设备可发起合法登记；持久身份与 init 值相同                | I+R   |
| C02 `Required deployment input is absent`                   | 每次分别移除一个必填字段、证书、签发密钥、已登记 DB，或损坏 DB              | 明确对应错误且未进入 ready；既有状态字节/身份不变，无重建身份/替代目录            | A+I   |
| C03 `Enroll a new device`                                   | 新本机公钥和有效单次凭证；提交持有证明并以结果认证                          | 稳定 deviceId 绑定原公钥，mTLS 后续请求成功；DB 只有凭证摘要，日志无原凭证        | A+I+R |
| C04 `Reuse or forge enrollment`                             | 分别提交已消费、过期、伪造凭证、错误持有证明及并发消费                      | 并发最多一次成功，其余精确拒绝；无重复/部分身份，无明文凭证落盘                   | A+I   |
| C05 `Pair two devices`                                      | 已登记不同物理设备；A 邀请、B 批准、A 确认指纹                              | 确认前无 DSH 权限；双方获得一致 pairId/固定公钥，后续连接不再复制 key/token       | I+R   |
| C06 `Unpaired device attempts access`                       | 第三台未配对设备请求关系、状态和信令                                        | 不返回目录、申请或会话；不转发，不新增关系，目标端无业务操作                      | A+I+R |
| C07 `A device key changes`                                  | 保留同 deviceId/名称，替换公钥或证书身份后连接                              | identity mismatch，既有 pinned key 不更新，无 DSH 凭证发出；重新配对入口可见      | A+I+R |
| C08 `Read and resolve an owned pairing request`             | 分别通过 UI 批准/拒绝准确申请，再重开页面查询                               | 仅该申请状态改变，权威读回一致；批准未绕过发起端指纹确认                          | A+I+R |
| C09 `Request expired or already changed`                    | 对过期、已拒绝、已处理及他人申请执行操作                                    | 明确过期/冲突/无权限；不创建替代申请，不误操作同名目标                            | A+I   |
| C10 `Enrollment response is interrupted`                    | 在消费前与消费后分别切断登记回复；同私钥查询结果                            | 返回未登记或原登记，状态与 DB 一致；不自动重复消费/创建身份，不向其他密钥公开结果 | A+I+R |
| C11 `Verify a new endpoint for the existing service`        | 相同服务签发身份与 DB 在新合法 TLS 端点公告；验证新鲜挑战再认证             | 挑战/身份/端点一致；旧配对读回一致，合法 TLS 续证不强迫换网络身份                 | A+I+R |
| C12 `A candidate endpoint cannot prove the pinned identity` | 分别篡改签名、nonce、服务身份、版本和端点，再尝试修改                       | 拒绝替换，旧配置不变；候选服务访问记录中无旧设备凭据或授权                        | A+I+R |
| C13 `Exchange valid negotiation messages`                   | 已配对两设备在同 attempt 交换 offer/answer/candidate                        | 只转发给精确对端；所有 envelope 身份/版本/序号一致，审计不含敏感正文              | A+I+R |
| C14 `Replay or cross-device injection`                      | 逐项重放、过期、超长、重复序号、伪造 sender、跨 attempt/pair、未知字段/版本 | 指定 typed 错误，不转发/分配业务资源；正常独立 peer 不受影响                      | A+I   |
| C15 `STUN request is received`                              | 真 UDP Binding；再发非 Binding、TURN Allocate、超长和超过预算的报文         | 合法请求仅返回观测地址；非法请求不提供 relay/开放代理；限流不绕过                 | A+I+R |
| C16 `Revoke a connected peer`                               | ready 会话中撤销；分别让对端收到/收不到撤销通知                             | DB 已撤销；收到即清理，失联最迟租约到期清理；不能继续续期/新建连接                | A+I+R |
| C17 `Coordination server becomes unavailable`               | 分别在新建会话前、ready 后停止协调服务                                      | 新连接失败；既有连接仅维持有效租约，过期关闭；无公共服务/SSH/中继替代             | A+I+R |
| C18 `Restart after paired use`                              | 持久化批准/撤销状态后重启服务，客户端逐个重连                               | 关系和撤销不变，presence 需重新认证；旧内存信令/attempt 不恢复成功                | I+R   |
| C19 `Restore an incompatible backup`                        | 分别恢复错误 schema、错误签发身份的备份                                     | 恢复停止并报告原因，备份及原数据不清空/覆盖，无新网络身份                         | A+I   |

### 8.3 客户端与完整界面用例（D）

用例名称与 `direct-peer-dsh-sessions` 的 Scenario 精确对应。编辑用例中 SSH/P2P 两种适用模式各自独立执行。

| ID / Scenario                                                        | 前置条件与操作                                                                | 预期结果与读回断言                                                                               | 层级    |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------- |
| D01 `Configure a P2P device`                                         | 显式配置、登记并配对一台电脑后重启客户端                                      | 服务/设备/关系持久值一致，Run 初始仅 Local；通过“+”显式创建一个 peer tab 后可见连接状态，无临时 Token/端口持久化        | I+R     |
| D02 `Required root or record is invalid`                             | 分别缺根、损坏/缺失已登记记录、未知 schema、密钥解密失败                      | 对应 typed 错误，无默认根、修复覆盖、明文密钥或伪空列表                                          | A+I     |
| D03 `Existing SSH user upgrades`                                     | 保存 Local/SSH 配置和现有会话后升级但不启用 P2P                               | catalog 原格式/内容不迁移，无 P2P 请求；原 Local/SSH 完整链路可用                                | I+R+P   |
| D04 `Configure and pair from the remote tab`                         | 全程只使用远程 Tab 控件完成配置、登记、申请/批准/确认                         | 每步有 pending/成功/错误，最终记录/tab 与服务关系一致；不手改文件、不复制私钥/DSH Token          | R       |
| D05 `Server is reachable but no peer session is ready`               | 只检查服务器、登记本机，不连接 peer                                           | 分项可达/已登记准确，live 不变绿、testStatus 不变 passed，无可用 DSH URL                         | A+R     |
| D06 `Data is loading or failed`                                      | 分别慢读记录、读取失败、真实零记录，随后刷新                                  | 三种 UI 明确不同；错误可重试，保留有效选择/滚动，不伪造空态数据                                  | A+I+R   |
| D07 `Rename a connected computer`                                    | SSH/P2P ready 且 WS 传输中改名保存                                            | 原 connectionId/tab/partition/运行 generation 不变，WS 不重连，列表与标签改名，持久读回新名称    | A+I+R   |
| D08 `Edit an SSH destination`                                        | 断开 SSH 后分别改 host、port、user 及组合，再测试/连接                        | 只修改选定记录；实际 SSH 使用新值，原 tab 不重建，旧测试清除，其他记录不变                       | A+I+R   |
| D09 `Save parameters while connected or busy`                        | 在 ready/testing/signaling/punching/disconnecting 各状态提交参数修改          | UI 明示需断开/busy，主进程独立拒绝；不自动断开/写入，草稿及其他电脑可用性保留                    | A+I+R   |
| D10 `Replace a trusted identity through editing`                     | 编辑 payload 注入 mode/deviceId/pairId/key/DSH target                         | 整体拒绝，无部分字段更新；旧授权保留，不接受同名替换，界面指向重新配对                           | A+I     |
| D11 `Update endpoints of the same coordinator`                       | 全部关联电脑断开；改同服务 HTTPS/WSS/STUN 并保存                              | 身份/端点成功校验后一次提交；各关联电脑 untested/disconnected，已打开 tab 与配对不变，无自动连接   | A+I+R   |
| D12 `One associated computer is still connected`                     | A/B 共用服务；A 断开但 B ready/testing，从 A 修改服务                         | 列出 B 阻止保存，主进程在最终提交时重查，不静默断开 B，不仅校验当前行                            | A+I+R   |
| D13 `New endpoint is unreachable or belongs to a different identity` | 修改到不可达、TLS 错误、不同身份、端点不匹配的服务                            | 原保存配置与关系不变，草稿保留，已断开的电脑不自动回连旧地址；新 origin 无旧凭据                 | A+I+R   |
| D14 `Validation or persistence fails`                                | 逐字段非法输入；注入磁盘满/无权限/原子提交失败                                | 错误定位准确，全部原字段保留；其他记录、tab 与输入不被覆盖；修正重试成功并读回                   | A+I+R   |
| D15 `Another edit or removal wins`                                   | 两编辑快照交叉提交；目标被移除；旧回复抵达已切换的编辑面板                    | 旧 revision 拒绝，不复活已移除对象，不污染新面板；原草稿保留供用户核对                           | A+I+R   |
| D16 `Cancel an unsubmitted draft`                                    | 脏/净表单各用取消、Escape、切换目标、返回 Run，及点击外部                     | 脏草稿需明确放弃；继续编辑保留；净表单可关闭；持久值不变，焦点恢复，不自动保存                   | A+R     |
| D17 `A save acknowledgment is lost`                                  | 提交前/后分别断开 IPC 回复或关闭编辑界面                                      | 结果未确认不是成功/取消；按原目标读回实际保存值，不自动重交，不丢草稿或覆盖别的目标              | A+I+R   |
| D18 `Operate using keyboard at a supported compact window size`      | 四架构、尺寸/语言矩阵；仅键盘编辑、纠错、保存/取消                            | 控件可见可达，无焦点丢失/重叠；错误有文字与可访问反馈，减弱动态效果不丢状态                      | A+R+P   |
| D19 `Navigate while a connection is active`                          | ready 时切其他侧栏/Run 再返回；登记时离开再进                                 | 连接不因组件卸载关闭，重新读取权威状态；普通输入按规则保留，登记秘密不恢复                       | A+R     |
| D20 `Establish direct communication`                                 | 已授权真实两机，允许 UDP 的 LAN/NAT/IPv6 下连接                               | 非 relay nominated pair、签名/DTLS/版本通过；HTTP 与真实 WS 成功才 ready，流量不经过 coordinator | I+R     |
| D21 `NAT prevents direct communication`                              | 禁 UDP 或受控无法打洞网络发起                                                 | 预算内 `p2p.direct_unavailable`、红色/文字错误；无 TURN/WSS/SSH/公开 STUN 兜底，无残留资源       | A+R     |
| D22 `Signaling is tampered with`                                     | 篡改 SDP fingerprint/ICE 凭证/对端身份/租约/签名                              | 业务开放前拒绝，未发 DSH Token/数据，具体身份/协议错误可见                                       | A+I     |
| D23 `Connect to an already running non-default port`                 | 远端实际公告非默认端口，客户端不填写 DSH port                                 | HTTP/WS 仅连接实际公告 authority，界面详情对应当前 runtime，无猜测 3080                          | I+R     |
| D24 `Change port settings while DSH is running`                      | ready 时在远端保存新端口但不重启 DSH                                          | 既有连接与新连接仍用旧实际公告端口，不提前改用未生效设置                                         | I+R     |
| D25 `DSH restarts with a new endpoint`                               | 重启远端使端口/Token 变化；同时延迟旧回调                                     | 旧 URL/streams/Token 不可用，tab 保留；显式重连只用新 generation，旧事件不能重新变绿             | A+I+R   |
| D26 `Start requires missing or invalid local prerequisites`          | 缺 root/tool/profile/选中 checkout、未知 ref、脏激活状态分别连接              | 原精确错误返回，不替换仓库/版本/全局 dsh，不修改 native DSH home                                 | A+I+R   |
| D27 `Use a remote DSH session`                                       | Local + 至少两个 peer 同时运行，登录并操作真实 DSH                            | HTTP/查询/Cookie/重定向/WS 语义正确，三者 session 隔离；断开一台不影响其余                       | I+R     |
| D28 `Exceed stream limits or inject another destination`             | 注入超预算 frame/streams/queue、跨 peer ID、任意 host/port、CONNECT/Origin    | 精确拒绝并清理适用流；无无限缓冲/越权 socket，正常独立连接继续                                   | A+I+R   |
| D29 `Test succeeds`                                                  | disconnected 状态点测试，完成 HTTP/WS 后检查监听器和 UI                       | testStatus passed，但 live disconnected，无可用 URL/临时流/隧道；不是常驻 ready                  | A+I+R   |
| D30 `Server reachable but DSH unavailable`                           | 服务可达、peer 可直连，但 DSH 启动/认证 HTTP/WS 分别失败                      | runtime/app 阶段精确报错，不变绿，不全折叠为 peer unavailable                                    | A+I+R   |
| D31 `Duplicate attempt or stale event`                               | 快速双点测试/连接、双向同时拨号；旧 generation 成功晚到                       | 单一有效 attempt，其余 busy；旧结果不修改当前 live/test/tab，不泄漏临时资源                      | A+I+R   |