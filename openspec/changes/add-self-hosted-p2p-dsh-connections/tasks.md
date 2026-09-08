## 1. 协议与构建边界

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

Electron helper 接入进展：主进程私有 RPC、严格 JSON framing、固定资源摘要校验、stdin 随机秘密和 Unix/named-pipe 认证已形成独立模块；真实 Go helper 诊断通过 8 次并发设备密钥生成、错误字段拒绝、取消准入和退出确认，25 项协议/RPC 单测及类型检查通过。新增 safeStorage 凭据模块尚待真实系统安全存储与服务登记/忘记流程集成验证。未接入正式 app composition、未完成打包资源和 UI；3.1/3.5 不勾选。完整 workspace validator 仍有文档机器路径、生成二进制及协议正则/管道字符串的路径检查发现，未将其标绿。

生命周期接续（2026-09-07）：建立请求从 Begin 前即持有可取消 session；Disconnect/Close 等待 gateway、mux、transport、续租及会话占用清理，目标 runtime invalidate 拒绝迟到 owner 凭据，失败终态不再立即覆盖为 disconnected。新增真实独立 coordinator + 两个生产 Go manager + 隔离真实 DSH 诊断，验证 5 次显式重连、真实 DSH 重启、新 runtime generation、旧入口关闭和 manager 退出后 DSH 继续可用。该诊断未启动两个 Electron App，不据此完成 3.5/4.1/5.10/7.8；命令与证据边界见 `docs/testing/p2p-runtime-session.md`。

Helper 接入进展（2026-09-07）：新增 Go helper、私有 RPC、runtime HTTP/WS gateway 与 session manager 的生产模块；修复 RPC 并发编号乱序、认证预读丢字节、连接 deadline 并发、gateway 关闭竞争及公钥类型比较错误。focused race 测试覆盖双向 800 次 RPC、错误密钥、协议拒绝、身份替换拒绝和 Pion 上 HTTP/WS 转发；Windows x64 helper 交叉编译仅作为编译证据。尚缺 Electron supervisor/安全持久化/UI/真实受管 DSH 生产组合及完整压力门禁，3.5、4.1、4.2 和发布任务不据此勾选。详见 `.agents/notes/2026-09-07-p2p-helper-integration.md`。

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
- [ ] 3.3 实现 Pion UDP ICE、设备签名 SDP/候选绑定及实际 DTLS fingerprint 准入。Owner: peer/transport；依赖: 1.2、2.5、3.2；验证: 两独立物理 peer 最小直连记录非 relay candidate pair，篡改协商失败；TURN/公共 STUN/SSH/WSS 中继不可启用。
- [ ] 3.4 实现可靠 DataChannel 流复用、FIN/RESET、credit 背压与帧/stream/队列预算。Owner: peer/transport；依赖: 3.3；验证: 大小边界、慢读、半关闭、并发流和跨 generation 注入测试通过，macOS/Windows 压力测试无无界队列或资源泄漏。
- [ ] 3.5 实现 main 监督 Go helper、Unix socket/Windows named pipe 隔离及启动握手。Owner: Electron p2p；依赖: 1.3、3.4；验证: 两平台取消、崩溃、退出及错误版本测试通过；缺 helper 不启动替代程序，无 TCP 管理入口。

## 4. 受管 DSH 数据通道

- [ ] 4.1 接入受管 runtime 的 start/state/invalidate，绑定实际启动 URL 和 runtime generation。Owner: Electron runtime/p2p；依赖: 3.5；验证: macOS/Windows 上运行中改设置仍用旧端口，重启后旧 Token/stream 失效；缺根/profile/工具、未知版本及脏状态沿用具体本地错误。
- [ ] 4.2 实现只指向当前受管 DSH 的 loopback HTTP/WS adapter。Owner: Electron p2p + peer；依赖: 3.4、4.1；验证: 真实 DSH 认证 HTTP、Cookie、重定向及 WebSocket 通过，Host/Origin/CONNECT/任意目标注入失败；保留路径和查询语义。
- [ ] 4.3 为 Local 与每个 peer 隔离 browser session partition，通过 main 将本地入口交给受限 Run guest。Owner: Electron browser；依赖: 4.2；验证: 至少 Local + 两个 peer 的 Cookie/Token 互不串用，普通 renderer projection 无原始远端 URL，断开后旧入口不可用。
- [ ] 4.4 实现阶段化连接状态、超时/取消、testStatus 与 live 状态分离及统一 generation 清理。Owner: Electron p2p；依赖: 4.2、4.3；验证: 测试包含真实 HTTP/WS 后销毁临时链路，Connect 才保留 ready；重复、旧回调、撤销、崩溃和退出均不污染其他连接。
- [ ] 4.5 实现远端用户授权根的选择/持久化/读回/撤销，以及绑定配对的命名根列表/目录分页能力。Owner: Electron/remote-projects；依赖: 1.3、1.4、3.5、5.1；验证: 无隐含整盘授权，真实目录列表精确匹配；缺授权/权限/目录错误分别反馈，撤销拒绝旧引用，控制面不承载工程数据。
- [ ] 4.6 实现目标系统路径规范化、实际根包含关系验证、不透明引用和操作时重检。Owner: Electron/remote-projects；依赖: 4.5；验证: Windows 盘符/大小写/保留名、Unicode、symlink/junction、遍历、目录替换、未授权 UNC、跨 peer/root/generation 注入逐项拒绝或准确读回，不扩大文件访问能力。
- [ ] 4.7 经已验证 DSH 原生契约完成工程打开、结果查询及工程/会话身份映射。Owner: Electron/runtime + domain；依赖: 1.4、4.2、4.6；验证: 真正打开远端工程后再成功，丢回复读回原请求，不重复创建，不替换成本机同名目录；原生权限审批不绕过。
- [ ] 4.8 接通真实 DSH 工作与断线任务核对，区分连接丢失/任务停止/结果未知。Owner: runtime/browser/domain；依赖: 4.3、4.4、4.7；验证: 经公开 UI 读取、修改隔离远端文件并执行验证任务，独立远端内容/任务读回一致、本机不变；断线/重连/重启均不自动重放操作，不伪造任务状态。

## 5. 多电脑界面与持久记录

- [ ] 5.1 实现已登记 settings root 下严格版本化的 P2P catalog，独立保存服务与配对记录。Owner: Electron persistence；依赖: 1.3、3.1；验证: 显式首次启用、重启、损坏/缺失已登记记录及未知版本测试通过；启用 P2P 不改 SSH catalog，明确 SSH 编辑仅修改选定记录且保持原格式。
- [ ] 5.2 接通新增 named IPC、preload 冻结能力与 remote-connections domain adapter。Owner: Electron/preload + renderer domain；依赖: 4.4、5.1；验证: 每项操作有正反 admission 测试，renderer 无文件/进程/任意网络能力，类型与架构检查通过。
- [ ] 5.3 在远程 Tab 增加 P2P 服务配置/分项检查、本机登记、设备邀请/批准/拒绝/指纹确认与撤销 UI。Owner: renderer remote-connections；依赖: 2.7、5.2；验证: macOS/Windows 可完成全流程，重开页面读回准确申请/授权状态，所有文案走 typed locale，无私钥复制或未知设备静默授权。
- [ ] 5.4 显示 presence、红绿连接状态、阶段与测试结果，保持一个 Local 和每台已登记电脑一个不可关闭固定 tab。Owner: renderer shell；依赖: 5.3；验证: 窄窗口和常规窗口可读，状态不只依赖颜色；离线/测试成功/真实连接/移除选中电脑等场景及 Local/SSH 回归通过。
- [ ] 5.5 实现 SSH 原子编辑和 P2P 本地名称更新，以及 configRevision 准入和记录级并发锁。Owner: Electron remote/persistence；依赖: 5.1、5.2；验证: 名称修改不断流，参数变更先断开，保存失败/旧 revision/已移除目标不部分覆盖；读回持久文件并验证原格式与其他记录不变。
- [ ] 5.6 实现共享 P2P 服务器配置编辑、影响集合锁和同服务身份/端点验证。Owner: Electron p2p；依赖: 2.7、5.5；验证: 任一关联电脑 busy 即拒绝，正常新地址成功保存、旧测试失效，不同服务身份不收到旧凭据，失败保持原配置且不自动重连。
- [ ] 5.7 实现统一编辑面板的预填、字段差异、保存/取消、脏草稿关闭确认、结果不明读回和冲突反馈。Owner: renderer remote-connections；依赖: 5.5、5.6；验证: SSH/P2P 全字段正反用例、指针/键盘/焦点、并发/迟到结果均通过，失败保留输入，登记秘密不当普通草稿保存。
- [ ] 5.8 接通 Run 断线页的连接/重试/编辑入口、打开原标签及名称同步，完善撤销后移除的部分成功状态。Owner: renderer shell + Electron lifecycle；依赖: 5.4、5.7；验证: 入口定位同一记录、改名不重载、旧 URL 不加载、撤销成功但删除失败保持 revoked，不影响 Local/其他电脑。
- [ ] 5.9 实施远程页/编辑区/Run 断线页完整交互与布局验收。Owner: QA/UI；依赖: 5.7、5.8、6.2、6.3、7.1、7.2；验证: 第 8 节全部界面用例有自动化断言及真实 UI 操作证据，760×560、常规窗口和现有小高度 smoke 均可操作，中英文长文案、焦点与减弱动态效果无遗漏；按依赖图执行，不提前启动 candidate E2E。
- [ ] 5.10 实现远端授权根管理和连接方目录/工程选择 UI，固定标签持续显示电脑/工程/会话归属与任务待确认状态。Owner: renderer/remote-projects；依赖: 4.5–4.8、5.2、5.4；验证: 面包屑/上级/刷新/分页/选择/取消、既有工程入口、空/加载/权限/失效状态、键盘/焦点/长路径/中英文均具真实入口，不使用本机原生目录弹窗冒充远端。5.9 与 7.2 同时要求本任务完成。

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
- 跨机基础矩阵为两种 Mac 架构 × 两种 Windows 架构 × 双向发起（8 个方向），逐项跑登记配对、名称/连接配置编辑、非默认端口、HTTP/WS、固定标签、断开和进程清理。
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
| D01 `Configure a P2P device`                                         | 显式配置、登记并配对一台电脑后重启客户端                                      | 服务/设备/关系持久值一致，仅一个固定 peer tab，初始 disconnected，无临时 Token/端口持久化        | I+R     |
| D02 `Required root or record is invalid`                             | 分别缺根、损坏/缺失已登记记录、未知 schema、密钥解密失败                      | 对应 typed 错误，无默认根、修复覆盖、明文密钥或伪空列表                                          | A+I     |
| D03 `Existing SSH user upgrades`                                     | 保存 Local/SSH 配置和现有会话后升级但不启用 P2P                               | catalog 原格式/内容不迁移，无 P2P 请求；原 Local/SSH 完整链路可用                                | I+R+P   |
| D04 `Configure and pair from the remote tab`                         | 全程只使用远程 Tab 控件完成配置、登记、申请/批准/确认                         | 每步有 pending/成功/错误，最终记录/tab 与服务关系一致；不手改文件、不复制私钥/DSH Token          | R       |
| D05 `Server is reachable but no peer session is ready`               | 只检查服务器、登记本机，不连接 peer                                           | 分项可达/已登记准确，live 不变绿、testStatus 不变 passed，无可用 DSH URL                         | A+R     |
| D06 `Data is loading or failed`                                      | 分别慢读记录、读取失败、真实零记录，随后刷新                                  | 三种 UI 明确不同；错误可重试，保留有效选择/滚动，不伪造空态数据                                  | A+I+R   |
| D07 `Rename a connected computer`                                    | SSH/P2P ready 且 WS 传输中改名保存                                            | 原 connectionId/tab/partition/运行 generation 不变，WS 不重连，列表与标签改名，持久读回新名称    | A+I+R   |
| D08 `Edit an SSH destination`                                        | 断开 SSH 后分别改 host、port、user 及组合，再测试/连接                        | 只修改选定记录；实际 SSH 使用新值，原 tab 不重建，旧测试清除，其他记录不变                       | A+I+R   |
| D09 `Save parameters while connected or busy`                        | 在 ready/testing/signaling/punching/disconnecting 各状态提交参数修改          | UI 明示需断开/busy，主进程独立拒绝；不自动断开/写入，草稿及其他电脑可用性保留                    | A+I+R   |
| D10 `Replace a trusted identity through editing`                     | 编辑 payload 注入 mode/deviceId/pairId/key/DSH target                         | 整体拒绝，无部分字段更新；旧授权保留，不接受同名替换，界面指向重新配对                           | A+I     |
| D11 `Update endpoints of the same coordinator`                       | 全部关联电脑断开；改同服务 HTTPS/WSS/STUN 并保存                              | 身份/端点成功校验后一次提交；各关联电脑 untested/disconnected，固定 tab 与配对不变，无自动连接   | A+I+R   |
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
| D32 `Disconnect or helper crashes`                                   | ready/connecting 时断开、kill helper、退出 app，各自执行                      | 所有归属资源收回；远端 DSH 不被停止，Local/其他 peer 不受影响，无旧 URL 加载                     | A+I+R+P |
| D33 `Remove a registered computer`                                   | SSH 断开或 P2P 已撤销断开，确认移除当前/非当前行                              | 成功持久删除后仅该 tab 消失；选中项移除后为 Local；未撤销 P2P/有 pending 时拒绝                  | A+I+R   |
| D34 `Open or edit from a disconnected fixed tab`                     | 在断线 tab 分别点编辑、连接/重试；从列表点打开标签                            | 定位同 record，保留返回路径，成功复用原 tab；不自动创建/连接或加载旧 URL                         | A+R     |
| D35 `Revocation succeeds but local removal fails`                    | 先成功撤销，再注入本地删除故障                                                | 展示 revoked/未移除，tab 留下但不可连接；重试仅删本地，不恢复/重复授权                           | A+I+R   |
| D36 `Renderer bypasses a disabled edit control`                      | 绕 UI 直接提交 busy 目标、旧 revision、额外字段的 typed 请求                  | main 拒绝且实际存储/网络不动，不能依赖按钮 disabled 保安全                                       | A+I     |
| D37 `Renderer supplies forbidden fields`                             | 每个新增操作分别测试未知 sender/字段/ID、路径、私钥、SDP、任意目标            | IPC 整体拒绝，无 helper 操作；合法一次性登记字段仅在指定登记操作准入                             | A+I     |
| D38 `Helper protocol is missing or incompatible`                     | 缺文件、错误架构/哈希/版本，伪造本机 helper 握手                              | helper_unavailable/protocol 错误；无系统/其他架构替代；Unix socket/named pipe 非授权访问拒绝     | A+I+P   |
| D39 `Validate supported platform pairs`                              | 执行 8 方向物理机基础矩阵并核对制品                                           | 每架构有独立真实配对/编辑/连接/清理结果与身份，不能以编译或 Mac 自连顶替 Windows                 | R+P     |
| D40 `Verify direct traffic across NAT`                               | 执行 8 方向 × 5 网络的核心矩阵，采集路径及服务流量                            | 可直连样本记录实际候选与业务直传；受阻样本明确失败；服务仅信令/心跳/STUN                         | R       |
| D41 `Inspect production packages`                                    | 构建 server/admin 与四客户端最终包并逐成员/依赖扫描                           | 无 ZeroTier、mock/fixture/simulator、秘密、错误架构或 desktop 中 server；真实入口 smoke 成功     | P       |
| D42 `Trace a requirement to complete evidence`                       | 对每条规格场景和可见操作查询用例/测试名/参数化记录/原始证据                   | 所有链接可解析，字段与身份断言准确，写操作有 UI/API/持久读回，无仅 200 的虚假证明                | A+I     |
| D43 `A case or required evidence is missing`                         | 分别移除场景绑定、参数结果、物理设备/ledger/网络证据，或令命令失败/用例未执行 | 验收 gate 失败或明确 blocked，相关任务未完成，不能通过 static/旧报告/其他平台放行                | A+I     |

### 8.4 边界、故障点与旧功能回归补充（X）

审查补充场景（同样初始 NOT_RUN）：

| ID / Scenario                                                   | 前置条件与操作                                                             | 预期结果与读回断言                                                             | 层级  |
| --------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----- |
| C20 `Restore a pre-revocation backup`                           | 先备份后撤销，离线对端保留旧凭证；显式 recover 旧备份                      | 新服务身份、旧设备/配对失效，旧凭证不能获租约，不能透明恢复旧授权              | A+I+R |
| C21 `Renew a paired device certificate`                         | 到续期窗口，原密钥 CSR；切断回复后读同 requestId                           | 同 deviceId/key/pairId、同一续期结果，旧证书到期前有效；标签不变               | A+I+R |
| C22 `Recover an expired certificate or reject revoked identity` | 过期/撤销/换钥/重复恢复凭证各自执行                                        | 仅未撤销且新单次凭证+原密钥可恢复，其他精确拒绝                                | A+I+R |
| D44 `Pair from two fresh user interfaces`                       | B 分享配对码，A 粘贴再双方确认；错服务/自身/过期/篡改/重用各执行           | 不预填未知 deviceId，不枚举目录，合法路径配对、非法路径不新增授权              | A+I+R |
| D45 `Forget an unreachable old service`                         | 旧服务永久离线；确认忘记，分别注入 tombstone 写入/密钥删除失败、新登记取消 | 旧信任禁用先于删除；失败保持 blocked、仅重试清理；不假报远端撤销，不恢复旧信任 | A+I+R |
| D46 `A business stream ends normally`                           | 页面刷新、正常 WS close、单流 RESET、仅信令 WSS 断开                       | 单流关闭不影响其他流/peer；信令失联时数据面按有效租约持续，到期关闭            | A+I+R |
| D47 `Test starts or cancels a cold runtime`                     | 测试冷启动成功/启动前取消/接受启动后取消/并发 start                        | 预告并报告运行进程保留；并发只有一个受管进程，测试仅清理自身连接               | A+I+R |

实现归属：C20 纳入 2.1/6.1；C21/C22 纳入 2.2/3.1；D44 纳入 2.3/5.3/1.3；D45 纳入 5.1–5.3/5.8；D46 纳入 3.4/4.4；D47 纳入 4.1/4.4/5.3。D32 修正故障范围：共享 helper 崩溃影响全部 P2P，Local/SSH 与远端 DSH 不变；单电脑断开仍仅影响该电脑。

| ID                        | 前置条件与操作（参数必须逐项展开）                                                                                                         | 预期结果与断言                                                                                                      | 层级  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----- |
| X01 编辑无变化            | 所有编辑对象预填后不改值或改后还原再保存                                                                                                   | no-op；无持久写入、连接/测试失效或 guest 重载，用户可关闭                                                           | A+I+R |
| X02 输入边界              | 必填项缺失/空/空白；port 为 0/1/65535/65536、负数/小数/非数字；host IPv4/IPv6/DNS；HTTPS/WSS 错 scheme、userinfo、非法 authority；长中文名 | 按字段合约独立接受/拒绝；合法值精确保留，不猜用户名/默认端口，不将 SSH port 当 DSH port；原记录不受失败影响         | A+I+R |
| X03 保存并发锁            | 同记录 rename/update/test/connect/remove 交叉；共享服务保存检查中启动其他关联 peer；独立第三台继续操作                                     | 目标级冲突严格拒绝，共享影响集合锁定；第三台不被全局 pending 锁住；迟到 finally 不清除新 pending                    | A+I+R |
| X04 提交故障点            | 分别在临时写入前、写入后/原子替换前、替换后/回复前杀进程，然后重启读回                                                                     | 文件是完整旧值或完整新值，无混合字段；界面与真实值一致，旧 generation 不复活，不把已提交说成取消                    | A+I+R |
| X05 时间边界              | 邀请/登记凭证在 5 分钟边界前/后；心跳 30 秒 stale；租约 20 秒续期/60 秒到期；设计各阶段预算前/后取消                                       | 有界等待且严格按真实期限/代次处理；不接受过期凭证/租约或重复 terminal，实际取消释放资源                             | A+I+R |
| X06 数据预算              | 数据帧 16 KiB 及 +1、控制帧 64 KiB 及 +1、streams 64/65、总队列 8 MiB 及 +1；慢读/零 credit/FIN/RESET/半关闭                               | 合法边界可用、超限拒绝；有背压，无无限 bufferedAmount、重复 close/泄漏，内容序列和归属正确                          | A+I   |
| X07 浏览器隔离与攻击      | Local+双 peer Cookie 同名；外部 Origin、伪 Host、恶意重定向、越权 Upgrade、跨 peer streamId；从普通 renderer 查询 Token                    | Cookie/分区/路由不串线，越权拒绝，普通 renderer 无远端原始凭据；真实合法 HTTP/WS 不被误拦                           | A+I+R |
| X08 重启与秘密            | 改名/参数后强制退出重开；safeStorage 不可用；导出日志/查看 process argv/DB/包                                                              | 配置读回准确且 live disconnected；无私钥/登记 Token/DSH Token/旧本地入口落盘或回显，无明文存储替代                  | I+R+P |
| X09 全界面状态与输入      | 远程页、申请区、编辑区、Run 断线页交叉空/加载/失败/部分成功/选中/禁用/pending/成功；四平台尺寸/语言/键盘/鼠标矩阵                          | 每个可达控件有入口/结果/取消或拒绝原因，焦点/滚动不乱跳，无布局裁切、假百分比或颜色独占状态                         | A+R+P |
| X10 身份说明重放          | 重用旧 nonce、修改端点说明、混用另一服务签名、重定向到新 origin、超长说明/高频请求                                                         | 验证和限流拒绝，旧凭据不出原信任范围；无目录泄露，TLS 续证但签发身份不变仍可合法验证                                | A+I+R |
| X11 撤销竞争              | 续期与撤销并发、保存配置与撤销并发、审批与拒绝同时提交，重复移除                                                                           | 服务事务确保最终撤销不可续期/复活；客户端读回真实最终状态，无半提交/同名误删或自动重建                              | A+I+R |
| X12 单向断网与恢复        | 分别中断 A→B、B→A 数据，单端控制面中断，系统休眠/恢复、网卡地址变化后重连                                                                  | 阶段/consent/租约及时反映故障，不保留假 ready；恢复网络不回放旧 attempt/Token，用户重连建立新 generation            | I+R   |
| X13 重复操作资源          | 连续执行测试→连接→断开与失败→重试；每轮比较归属 PID、socket、streams、session/队列                                                         | 不随轮数累计残留；独立 peer/Local 正常，崩溃/退出清理与成功路径同样可证                                             | I+R+P |
| X14 既有 Harness/SSH 回归 | clone/注册、精确 ref 激活、脏目录拒绝、缺根/工具/profile、启动/停止、SSH 身份错误与 peer descriptor 缺失                                   | 旧合约与具体错误不变；native DSH home 未迁移，原生产 service/node 禁用；SSH 测试清理完整，不假报 P2P 成功           | A+I+R |
| X15 用例与证据完整性      | 对两个 spec 的所有 Scenario、所有新增 IPC、生产改动文件和交互控件做追踪扫描，故意移除一个绑定/原始证据或声明 skip                          | gate 必须失败；缺场景、字段来源、身份键、物理机证据、ledger、包扫描或命令非零均阻止验收，不以截图/摘要/静态检查放行 | A+I   |

### 8.5 完整远程工作台新增场景

以下场景对应本次用户确认的目录/工程/任务与发布闭环，初始均为 NOT_RUN，不引用 Go-only 历史结果放行。实现归属：D48–D50 → 4.5；D51–D54 → 4.6/5.10；D55–D56 → 4.7；D57–D59 → 4.8/7.8；D60–D61 → 7.7/7.9。UI 变更全部进入同一 interactive 合约。

| ID / Scenario | 前置条件与操作 | 预期结果与读回断言 | 层级 |
| --- | --- | --- | --- |
| D48 `Grant and reuse a remote project root` | 远端用户为 A 授权实际根，A 多次打开选择器 | 根/配对/设备持久读回一致；只显示获准根，不要求远端重复弹窗 | I+R |
| D49 `No root is authorized` | 已配对但授权根为空 | 显示尚未授权，不选择 HOME/整盘/最近路径，不伪空目录 | A+I+R |
| D50 `Revoke a project discovery grant` | A 持有列表/引用时远端撤销根 | 后续列举/打开拒绝旧引用；其他根不变，不假称 DSH 任务已停止 | A+I+R |
| D51 `Browse and select a remote directory` | 本机/远端存在同名不同内容目录，通过公开选择器浏览确认 | 远端列表与真实 FS 一致，设备/路径归属正确；本机目录未选择或修改 | I+R |
| D52 `Handle platform paths and changed directories` | 盘符/大小写/Unicode/空格/删除/权限变化/未授权 UNC 独立展开 | 按远端 OS 精确读回或 typed 拒绝，未授权 UNC 无访问，无路径替代 | A+I+R |
| D53 `Reject escaped and stale directory references` | 遍历、越界 symlink/junction、目录替换、跨 peer/root/generation | 实际操作边界重检并拒绝，无越权列表/工程副作用 | A+I+R |
| D54 `Cancel or supersede directory browsing` | 大目录分页中取消、切电脑、断网及迟到页 | 原请求终止，旧页不改新 UI，内存受限且焦点/重试可用 | A+I+R |
| D55 `Open and read back a remote project` | 公开 UI 选择真实远端工程 | DSH 工程/会话与 UI 精确读回一致，失败不显示打开成功、不创建本机工程 | I+R |
| D56 `Project opening response is lost` | 远端接受前/后分别中断回复 | 未确认状态准确，查原请求/会话，无自动重复创建或替代目录 | A+I+R |
| D57 `Execute work in the selected remote project` | 真实 DSH UI 读文件、批准修改、执行无外部副作用任务 | 远端文件内容/任务结果与 UI 和原生记录一致，本机/其他 peer 不变 | I+R+P |
| D58 `Recover a task after losing the connection` | 任务已接受时断网，随后公开 UI 显式重连 | 查询原任务实际结果，不重放命令/写入，不将断网当停止 | I+R+P |
| D59 `Runtime restart prevents task reconciliation` | 任务结果未知时远端 runtime 重启或记录缺失 | 显示无法确认，不猜终态，不复活旧 generation 或污染新工程 | A+I+R |
| D60 `Publish a fully validated remote workbench` | 完整实现、质量/平台/包证据通过后执行发布 | 提交/版本/标签/四原生构建/publish/实际资源可追踪，无无关改动或秘密 | I+R+P |
| D61 `Transport passes but workbench evidence is missing` | 保留 Go 绿测，分别移除工作台/平台/ledger/包证据 | 正式发布 gate 拒绝，不把诊断、隐藏功能或旧包当完成 | A+I |
| D62 `Manage a private network in the remote tab` | 用户经公开 UI 登录、创建/选择/改名自己的网络；使用第二账号核对 | 网络身份与服务端读回一致，其他用户资源不可见，绑定/配对未跨网络，普通 renderer 无用户令牌 | A+I+R |
| D63 `Remove network authorization` | 删除网络/解绑设备，分别在连接中和存在浏览引用时执行，再重绑 | 相关 ready/授权失效，旧引用拒绝，重绑不恢复配对；Local/SSH/其他网络不变 | A+I+R |

D62/D63 补齐此前已有但漏入逐场景表的用户网络操作，归属 2.6/5.3/7.2；它们同样属于完整发布门槛。

| ID / Scenario | 前置条件与操作 | 预期结果与读回断言 | 层级 |
| --- | --- | --- | --- |
| D64 `Cancel an owned management request` | 两个真实页面并发管理；取消/导航/销毁其中一个，并在服务写入后延迟回复 | 只取消原页面请求；已接受写入为未确认且显式读回，无自动重放；另一页面/网络不变 | A+I+R |
| D65 `Replay or overload management IPC` | 15 项入口逐一注入旧序号、未知版本/字段/秘密、子 frame/外部 sender；16 并发后继续请求/取消 | 业务 owner 不接收非法输入；第 17 项拒绝，取消仍可操作；新文档可从新序号开始但旧回复不污染它 | A+I |

### 8.6 命令、证据与通过条件

当前仓库已存在、实现后必须运行的命令如下。新 Go module 与新用例 harness 属于上面未完成的实现任务，未产生前不得声称可运行或通过。

```bash
# 现有 SSH / browser focused 基线；不能替代新 P2P 测试或完整套件
npm test -- --run electron/main/remote electron/main/remote-ipc.test.ts electron/main/runtime-browser-controller.test.ts electron/main/runtime-browser-ipc.test.ts

# networking/ 创建后，在该目录执行
# 集成套件要求显式提供已构建的独立服务器二进制；未提供直接失败，不 skip。
# 执行者先设置 DSHKER_SERVER_BINARY 为实际独立服务制品的绝对路径；不猜本机路径。
test -n "$DSHKER_SERVER_BINARY"
go test ./...
go test -race ./...
go vet ./...

# 在 DSHKer 仓库执行
npm run environment:check
npm run format:check
npm run architecture:check
npm run type-check
npm test -- --run
npm run service:smoke
npm run visual:smoke
npm run build
npm run build:electron
npm run release:readiness -- --json
npm run package
npm run release:verify
npm run release:smoke -- --launch-timeout-ms 60000
openspec validate add-self-hosted-p2p-dsh-connections --strict

# 在 desktop_workspace 根目录执行
node tools/validate-desktop-app.mjs --app apps/dsh-launcher --json
```

Go race 在工具链支持的真实平台运行；不支持的架构需明确记录限制，并提供该架构的 native 集成/压力证据，不能将交叉编译记为 race 通过。每个新测试文件、真实 UI E2E 和 server/peer no-mock 命令在任务 7.1/7.2 中登记确切路径与测试名；这里不发明尚不存在的 npm script。

实现阶段 `test-gates/` 清单按 quality-engineering 的 test-integrity 和 interactive 合约创建，记录所有新增/修改生产文件、source field→assertion、六类状态及 superseded、原始交互账本与跨机网络证据。运行该技能 `scripts/check_test_integrity.py` 的默认 verify，以及 `scripts/check_interaction_ledger.py` 的 ledger 验证；static 仅用于编写反馈。当前已有部分生产实现与诊断清单，但没有完整工作台 candidate E2E；不得创建空清单或将部分实现标成 implementation_complete 冒充通过。

最终通过必须同时满足：所有规格场景被本节用例追踪；每个适用参数/平台/网络有独立可复查结果；新增自动化、既有完整套件、构建、真实 UI/网络、包检查和安全边界全部通过。FAIL、BLOCKED、NOT_RUN、缺少测试设备、未生成 harness 或缺原始证据均保持相关任务未完成；不得归档、宣称功能完整或发布就绪。

## 9. 已批准的 DSH 客户端扩展

- [ ] 9.3 完整功能及本地生产组合、隔离、安全、构建/包检查通过后发布联测 prerelease。Owner: integration/release；依赖: 全部功能实现与本地门禁；验证: prerelease 版本/标签/提交及四架构构建一致，GitHub prerelease=true、非 latest，发布说明列明 Win/Mac 物理联测未执行；用户联测后再按 7.9 晋级正式版。

- [x] 9.1 实现独立客户端插件的版本化导航、真实 public service 适配、身份读回、取消/并发和测试，并针对显式选定 Harness 构建。Owner: Launcher extension；依赖: 1.4 的源码审计；验证: `Navigate through the supported client extension`、`Cancel a pending client navigation`、`Selection readback does not match the requested project`，拒绝错误路径/会话、过期序号、迟到结果；类型引用来自实际 Harness，生产 bundle 不含测试或未解析依赖；真实 DSH 客户端运行读回后方可完成。
- [ ] 9.2 实现安全 guest preload/main 准入、插件安装/版本检查与远端工程操作接入。Owner: Electron/runtime + renderer；依赖: 9.1、4.5–4.7；验证: `Reject an incompatible or foreign navigation channel`，假 sender/subframe/错误 guest、attempt/runtime 变化、销毁/超时/重复回执拒绝；只加载固定资源路径，原任意 preload 拒绝策略不削弱；Local/SSH 回归及真实双 peer UI 完成，纳入 5.10/7.8 发布前置。

## 10. 边界修订：登记免登录 + 组网数上限 + 双子 Tab 远程连接（2026-09-08）

用户确认的最终边界：本机设备身份在启动时已生成；加入网络（登记）凭 networkId 免登录完成；登录与授权确认仅在“组网”（建立设备间 DSH 连接）前要求；网络创建/管理需登录；单个 network 设置组网设备数上限，默认 10、可由网络创建者提高到 20/30。对应 spec 已更新：`self-hosted-peer-coordination/spec.md` 的登记 requirement 与新增 “Network device capacity is bounded”；`direct-peer-dsh-sessions/spec.md` 的远程连接 Tab 拆为 Tab 1「连接」（免登录）+ Tab 2「网络与账户」（登录）。以下任务在相应既有任务通过前不提前勾选；涉及 `ankye/dshker-server` 的服务器契约由该仓库的 `add-dshker-user-networks` 承接。

- [ ] 10.1 将 registerDevice 契约改为凭 networkId 免登录登记：renderer 提交 networkId + 本机公钥持有证明即登记，移除“已登录用户申请凭证”的前置；保留设备私钥本机生成、结果原子持久化/读回、凭证原子消费与防重放；未提供 networkId 或超限返回明确错误。Owner: client p2p + server；依赖: 5.2、6.2；验证: 未登录状态下凭 networkId 完成登记并读回一致，无登录/选网络的设备正常加入；跨仓 server 契约同步更新。
- [ ] 10.2 为 network 增加组网设备数上限：创建网络时可设置（默认 10），已登录拥有者可编辑提高到 20/30；登记/加入时校验上限，超限返回“网络已满”并拒绝，降低上限不静默踢出已登记设备。Owner: client p2p + server；依赖: 5.3、6.2、10.1；验证: 上限持久化读回一致，满员拒绝/提高后可加入的场景在真实客户端+服务器通过。
- [ ] 10.3 将远程连接 Tab 拆为两个子 Tab：Tab 1「连接」（免登录：SSH 管理 + 加入网络）；Tab 2「网络与账户」（未登录显示登录注册页，登录后显示网络管理）。跨子 Tab 依赖以引导态处理，不自动切 Tab、不重复输入。Owner: renderer remote-connections + shell；依赖: 5.2、5.3、5.4、10.1、10.2；验证: 窄/常规窗口全流程、未登录/已登录/空态/错误/超限态逐项可操作，中英文文案 typed locale，真实 macOS/Windows 验收。
- [ ] 10.4 重新设计加入网络流程为单表单：输入服务器地址（https://域名:端口）+ networkId → 点「加入」登记（免登录）→ 按钮变「取消」、状态显示「等待审核」→ 审核通过后状态显示 online/offline → 按钮变「离开网络」。移除独立的“P2P 服务管理”先配置步骤；加入页直接承载服务器地址与 networkId。提供已配服务下拉可复用既有服务，也允许直接输入新地址。Owner: renderer remote-connections + p2p join；依赖: 10.1、10.3；验证: 免登录加入全状态机（未加入→等待审核→online/offline→离开）可操作且文案 typed locale。
- [ ] 10.5 支持删除/离开：已配置服务可删除（forgottenServiceIds 遗忘机制）；已登记设备在「等待审核」中可取消、审核通过后可「离开网络」（解绑设备）。UI 增加删除/取消/离开按钮与确认，删除后不允许悄悄恢复。Owner: client p2p + server；依赖: 10.1、10.3、10.4；验证: 删除服务不复活、离开网络后不能自动恢复配对、取消等待审核不产生残留。
- [ ] 10.6 网络与账户：未登录显示登录注册页，使用邮箱+密码登录/注册；登录后网络管理 CRUD（每用户最多 2 个网络，第 3 个拒绝），点网络进入该网络管理界面做设备 CRUD 与认证（批准/拒绝/撤销配对、绑定/解绑设备、查看设备列表与在线状态）。Owner: renderer + server accounts；依赖: 10.3、10.4；验证: 邮箱登录注册、2 网络上限、网络内设备 CRUD/认证全流程 typed locale，跨仓 server 支持邮箱与注册接口。
- [ ] 10.7 连接监督与自动重连：客户端启动后自动连接已配置服务器并获取本机登记/membership 状态驱动 UI；定时健康检测（正常 >= 30s）；失败后指数退避重连（1s 起倍增、上限 60s、成功后回落）；重连期间保持最后一次已知状态、成功后以服务器权威状态刷新；退出/主动断开停止定时器。Owner: Electron p2p supervision + renderer；依赖: 10.1、10.3、10.4；验证: 启动取状态、正常轮询、断线重连/退避/回落、退出清理定时器的自动化与真实服务器场景通过。

