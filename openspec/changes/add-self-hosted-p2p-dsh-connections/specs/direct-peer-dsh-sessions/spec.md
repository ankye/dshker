## Purpose

让 DSHKer 客户端在自建 Go 协调服务帮助下，与明确配对的另一台电脑建立认证、加密的直连 DSH 会话，保持动态端口、固定浏览器标签、准确状态和 macOS/Windows 对等行为。

## ADDED Requirements

### Requirement: Explicit P2P registration preserves existing modes

The Launcher SHALL 提供显式 P2P 服务配置和设备登记，使用已登记的 settings root 持久化稳定服务/设备/配对身份；SHALL NOT 因启用 P2P 修改现有 SSH catalog、自动按 IP/名称迁移设备或在失败时选择 SSH。SSH 记录仅 SHALL 由用户明确的新增、编辑、移除操作修改，保持原持久格式。临时 ICE 信息、业务凭证、本地端口、PID 和连接错误 SHALL NOT 持久化。

#### Scenario: Configure a P2P device

- **WHEN** 用户明确提供合法自建服务配置并完成登记配对
- **THEN** Launcher 持久化对应服务及设备标识，创建一个固定 peer tab，初始为 disconnected

#### Scenario: Required root or record is invalid

- **WHEN** 已登记根不存在、P2P 记录损坏/未知版本、服务字段缺失或密钥不可解密
- **THEN** Launcher 返回具体错误，不猜测目录、修复记录或使用明文密钥

#### Scenario: Existing SSH user upgrades

- **WHEN** 用户升级而未启用 P2P
- **THEN** Local 和原 SSH 记录继续按原合约工作，不触发登记、配对或网络变更

### Requirement: Remote tab exposes complete management workflows

The Launcher SHALL 在左侧远程连接 Tab 提供协调服务器配置/检查/编辑、用户登录/登出、自己的网络创建/改名/删除、设备绑定/解绑、本机登记、配对申请处理和已登记电脑列表。电脑列表 SHALL 按 SSH/P2P 模式提供明确的新增、测试、连接/取消/断开、编辑、打开固定标签、撤销配对及移除操作，并显示适用条件和实际操作状态，不能要求用户手工编辑配置文件完成这些流程。网络必须显式选择，SHALL NOT 猜测默认网络或把用户会话作为设备身份。

#### Scenario: Manage a private network in the remote tab

- **WHEN** 用户登录独立服务器并创建、选择或修改自己的网络
- **THEN** 显示服务端返回的实际网络身份和操作结果，绑定与配对限定该网络，不显示其他用户资源；用户会话秘密不进入普通 renderer 状态

#### Scenario: Remove network authorization

- **WHEN** 用户明确删除网络或解绑设备并获服务端确认
- **THEN** 相关 P2P 标签不再保持 ready，固定本地标签与其他网络/SSH 连接不变；重绑仍需重新配对，不恢复已撤销授权

#### Scenario: Configure and pair from the remote tab

- **WHEN** 用户尚未配置 P2P，并从远程 Tab 提供服务器信息、登记本机并完成双方配对确认
- **THEN** 每一步有界面入口及真实结果，成功配对后出现对应电脑记录与固定标签，不要求复制设备私钥或 DSH Token

#### Scenario: Server is reachable but no peer session is ready

- **WHEN** 服务器检查或本机登记成功，但尚未通过一台电脑的 DSH 连接检查
- **THEN** 只更新服务器/登记状态，不将电脑的 live/testStatus 设为成功，不启用失效的 DSH 页面

#### Scenario: Data is loading or failed

- **WHEN** 远程记录正在加载、读取失败或确实为空
- **THEN** 分别显示加载、带重试的错误或新增/配对入口；不能将失败伪装为空列表，刷新保留仍存在的目标选择与滚动位置

### Requirement: Explicit record editing preserves identity and sessions

The Launcher SHALL 预填当前持久记录，支持 SSH 显示名称/host/SSH port/user 和 P2P 本地显示名称的编辑。P2P 记录 SHALL 提供所属服务器配置编辑入口。记录身份、传输模式、配对公钥及远端 DSH 端口/Token SHALL NOT 作为普通可编辑字段。仅名称修改成功 SHALL 保持现有连接、测试结果、浏览器会话及固定标签身份。

#### Scenario: Rename a connected computer

- **WHEN** 已连接且没有冲突操作的电脑仅保存新的显示名称
- **THEN** 设备列表和原固定标签显示新名称，连接不断流、guest 不重载、顺序与选中状态不变，远端身份及名称不被修改

#### Scenario: Edit an SSH destination

- **WHEN** 用户修改 SSH host、port 或 user 并在该记录断开、无测试/协商后保存
- **THEN** 只更新目标记录允许字段，保留 connectionId 与 tab，testStatus 变为 untested，旧 generation/URL 失效；后续测试/连接使用新值

#### Scenario: Save parameters while connected or busy

- **WHEN** 修改连接参数时受影响记录仍连接、测试、协商或正在断开
- **THEN** 保存被明确拒绝并显示需先断开的对象或 busy 原因，草稿保留，不自动断开或保存；未受影响电脑仍可操作

#### Scenario: Replace a trusted identity through editing

- **WHEN** 编辑请求试图修改模式、deviceId、pairId、公钥或指定任意 DSH 目标
- **THEN** 整体请求被拒绝，界面指向合法的新增/重新登记/配对流程，不覆盖旧身份或授权

### Requirement: Shared coordinator edits validate scope and trust

The Launcher SHALL 明示协调服务器编辑影响的全部关联电脑，要求这些电脑断开且无待处理测试/协商后才提交。已登记服务的新端点 SHALL 通过原服务身份、协议及设备关系检查才能原子替换。SHALL NOT 将旧设备凭据发送给未验证身份的新 origin，或将旧配对授权迁移到另一个服务身份。

#### Scenario: Update endpoints of the same coordinator

- **WHEN** 用户在全部关联电脑断开后提交同一协调服务的新 HTTPS/WSS/STUN 端点，身份及端点检查通过
- **THEN** 保存新配置、保留有效配对与固定标签、将关联电脑测试结果清为 untested 并保持 disconnected，不自动测试或重连

#### Scenario: One associated computer is still connected

- **WHEN** 用户从电脑 A 进入所属服务器编辑，但共享配置的电脑 B 仍连接或测试中
- **THEN** 界面和主进程均报告 B 阻止提交，不能只检查 A 或静默断开 B

#### Scenario: New endpoint is unreachable or belongs to a different identity

- **WHEN** TLS、服务身份、设备关系、协议或端点检查失败
- **THEN** 保存失败，原配置和配对不变、草稿保留、已断开的电脑保持断开；不同身份要求重新登记/配对，不携带旧凭据重试新 origin

### Requirement: Editing has atomic persistence and honest recovery

The Launcher SHALL 只在持久写入确认后显示保存成功；输入无效、并发冲突或写入失败时 SHALL 保留草稿及原配置且不产生部分更新。保存 SHALL 绑定目标和读入的配置版本，迟到结果不能覆盖新配置或另一个编辑目标。已接收的写操作 SHALL NOT 因关闭界面被描述为已取消；结果不明时 SHALL 重新读取权威记录确认，不能猜测成功或自动重交。

#### Scenario: Validation or persistence fails

- **WHEN** 必填项为空、端口无效或持久写入失败
- **THEN** 显示字段/操作错误并保留有效输入、原配置及其他电脑状态，用户可以修正后主动重试

#### Scenario: Another edit or removal wins

- **WHEN** 用户提交期间该记录已被更新/移除，或旧保存响应抵达另一个编辑面板
- **THEN** 旧修改不覆盖新记录，不重建已移除目标；提示冲突并保留草稿，重新载入需由用户选择

#### Scenario: Cancel an unsubmitted draft

- **WHEN** 用户关闭或切换有未保存修改的编辑面板
- **THEN** 提供继续编辑或放弃修改，只有明确放弃才丢弃草稿；取消不写入配置，关闭后焦点回到有效的原入口

#### Scenario: A save acknowledgment is lost

- **WHEN** 保存已发出但结果无法确认
- **THEN** 显示结果未确认并重新读取原记录，按实际持久值解决结果；未确认前不显示成功、不自动重复提交或丢弃草稿

### Requirement: Remote management remains accessible and actionable

The Launcher SHALL 为操作提供保存/取消/编辑等可见控件、键盘焦点及文字反馈，并区分未连接、测试通过、真实 ready、正在操作及失败。长名称、长地址、多行错误和支持的语言/窗口尺寸 SHALL 不遮挡操作。减少动态效果 SHALL 不丢失状态；一次性登记凭证 SHALL 在结束/关闭后清除而非作为普通草稿持久保留。

#### Scenario: Operate using keyboard at a supported compact window size

- **WHEN** 用户通过键盘打开编辑、提交无效字段、修正后保存或取消，并使用长名称/地址和多行错误
- **THEN** 焦点顺序、错误说明、保存/取消入口均可到达且无重叠或不可操作的裁切，操作结果有文字与可访问反馈

#### Scenario: Navigate while a connection is active

- **WHEN** 用户离开远程管理页再返回
- **THEN** 活跃会话继续由共享状态管理，不因页面卸载断开；页面显示权威结果而非遗留 pending，登记秘密不随草稿恢复

### Requirement: DSH business traffic uses authenticated direct paths only

The Launcher SHALL 仅通过两台设备间的非 relay ICE 候选对建立加密业务连接，并验证持久配对身份与 DTLS fingerprint 的绑定。The Launcher SHALL 拒绝 TURN、relay candidates、公共服务替代以及 WSS 业务转发；SHALL NOT 把信令/STUN/端口打开计为连接成功。

#### Scenario: Establish direct communication

- **WHEN** 获授权设备协商出非 relay 候选对并通过对端签名、DTLS 和协议版本校验
- **THEN** 两端可开启直连 peer 会话，状态显示实际 candidate 类型与后续 DSH 验证阶段

#### Scenario: NAT prevents direct communication

- **WHEN** 直连预算耗尽或只有 relay 路径可用
- **THEN** 连接以 `p2p.direct_unavailable` 失败，停止该 attempt，不建立中继或 SSH 业务流

#### Scenario: Signaling is tampered with

- **WHEN** SDP fingerprint、双方身份、attempt、租约或签名校验失败
- **THEN** 客户端在发送 DSH 凭证和业务内容之前关闭连接并报告身份/协议错误

### Requirement: Remote runtime remains authoritative for its dynamic endpoint

The remote Launcher SHALL 使用当前受管 DSH 实际启动公告中的 URL、端口和凭证，并将会话绑定到 runtime generation。The Launcher SHALL NOT 以固定端口或尚未生效的设置替代当前公告，不允许调用者指定任意远端目标地址。

#### Scenario: Connect to an already running non-default port

- **WHEN** 远端 DSH 运行在其实际公告的任意有效 loopback 端口
- **THEN** 认证 peer 会话映射该端口而无需用户填写 DSH 端口或 Token

#### Scenario: Change port settings while DSH is running

- **WHEN** 用户保存新端口但原 DSH 进程尚未重启
- **THEN** 当前连接继续绑定旧进程公告，不提前连接新设置中的端口

#### Scenario: DSH restarts with a new endpoint

- **WHEN** 远端进程重启并公告新端口或 Token
- **THEN** 旧 generation 的 streams、URL 和凭证失效，固定标签保留，重连使用新公告

#### Scenario: Start requires missing or invalid local prerequisites

- **WHEN** 远端 DSH 未运行且原有根、工具、profile、已注册 checkout 或精确选定版本不可用，或激活遇到脏状态
- **THEN** 沿用本地启动/激活错误并终止远程会话，不克隆替代仓库、换版本或修改 native DSH home

### Requirement: Scoped HTTP and WebSocket bridging isolates peers

The Launcher SHALL 只为获授权 peer 的当前 DSH 提供本地 loopback 浏览入口，支持实际 DSH HTTP、Cookie 和 WebSocket 语义。不同 peer 和 Local SHALL 使用隔离 browser session，断开 SHALL 关闭对应入口和瞬态会话。The Launcher SHALL 拒绝任意 host/port、CONNECT、越权 Origin 和跨 peer stream。

#### Scenario: Use a remote DSH session

- **WHEN** 用户打开已连接 peer 的固定标签
- **THEN** HTTP 认证、页面请求和实际 WebSocket 经过该 peer 的直连流访问受管 DSH，并与 Local 和其他 peer 的 Cookie/状态隔离

#### Scenario: Exceed stream limits or inject another destination

- **WHEN** 输入超出帧/stream/排队预算，或要求访问非当前 DSH authority
- **THEN** 适用流或连接被明确拒绝并释放资源，不无限缓冲或扩展转发权限

### Requirement: Connection and test states prove application readiness

The Launcher SHALL 分别显示设备 presence、连接状态和 testStatus。绿色 ready SHALL 要求直连、身份、版本、DSH 认证 HTTP 和实际 WebSocket 检查通过；失败 SHALL 显示红色与阶段化 typed 错误，协商中使用非成功颜色且有文本。

#### Scenario: Test succeeds

- **WHEN** 用户点击测试且同一生产连接路径通过直连及 DSH 应用检查
- **THEN** 所有测试通道和临时入口清理后 testStatus 变为 passed，live 状态保持 disconnected，不能留下可用 URL

#### Scenario: Server reachable but DSH unavailable

- **WHEN** 协调服务器可达甚至 peer 直连成功，但远端 DSH 未能就绪或应用探测失败
- **THEN** 显示 runtime/app 阶段失败，不能变绿或将错误统一描述为 peer 不可用

#### Scenario: Duplicate attempt or stale event

- **WHEN** 正在测试/连接时重复发起操作，或旧 generation 返回成功事件
- **THEN** 重复操作返回 busy，旧事件不能修改当前连接/标签状态

### Requirement: Fixed tabs and lifecycle cleanup preserve device identity

The Run page SHALL 保留一个不可关闭的 Local 标签和每个已登记远端电脑记录的一个固定标签。每次断开、撤销、helper 崩溃、连接失效或应用退出 SHALL 关闭所属 generation 的 socket、stream、本地入口和临时凭证；断开 SHALL NOT 停止远端 DSH 或其他连接。

#### Scenario: Disconnect or helper crashes

- **WHEN** 用户断开或 helper 意外退出
- **THEN** live 状态退出 ready、tab 保留但不可加载旧 URL；单电脑断开只清理所属连接，共享 helper 崩溃清理全部 P2P 连接；远端 DSH、Local 和 SSH 不被停止

#### Scenario: Remove a registered computer

- **WHEN** 用户明确移除已断开且无待处理操作的电脑登记，且 P2P 配对已确认撤销
- **THEN** 只删除该登记及其 tab，删除当前选中项后选择 Local，不按同名信息删除其他记录

#### Scenario: Open or edit from a disconnected fixed tab

- **WHEN** 用户打开未连接电脑的固定标签，选择连接/重试或编辑
- **THEN** 标签显示该电脑的真实状态，连接作用于原记录，编辑定位远程页中的同一记录；成功后复用原 tab，不创建临时标签或加载旧 URL

#### Scenario: Revocation succeeds but local removal fails

- **WHEN** P2P 配对已撤销，但本地记录持久删除失败
- **THEN** 保留已撤销且断开的记录/tab 并报告未移除，重试只执行本地移除，不恢复授权或假报整体完成

### Requirement: Named IPC confines network and secret authority

The Launcher SHALL 仅通过版本化命名操作开放配置/检查/编辑服务、登记、配对申请处理、撤销、列表、测试、连接、断开、记录编辑与移除，以及获授权的目录选择和工程打开/结果读回；主进程 SHALL 验证调用者、严格 payload、配置版本及当前操作准入状态。普通 renderer SHALL NOT 获得 shell、任意网络/文件访问、私钥、SDP/ICE 或远端原始 DSH URL；只有受限 guest 经主进程获得使用该会话所必需的本地入口。目录选择 SHALL 使用绑定当前授权与会话的不透明引用，而不是任意文件路径参数。

#### Scenario: Renderer bypasses a disabled edit control

- **WHEN** renderer 直接发送已连接目标的参数修改、旧配置版本或超出允许范围的字段
- **THEN** 主进程整体拒绝，不以界面按钮状态作为权限边界，不写入配置或启动新链路

#### Scenario: Renderer supplies forbidden fields

- **WHEN** payload 含未知字段、可执行路径、文件路径、设备私钥/远端运行时凭证、任意转发目的地或未知 deviceId（登记仅准入一次性登记凭证，邀请仅准入经过同服务签名/期限校验的目标配对码）
- **THEN** 请求整体被拒绝且不会启动 helper 业务操作

#### Scenario: Helper protocol is missing or incompatible

- **WHEN** 当前平台 helper 不存在、完整性失败或握手版本不匹配
- **THEN** P2P 能力明确失败，不搜寻系统替代程序、不启用其他架构 helper 或旧传输

### Requirement: Packaged clients prove cross-platform direct behavior

The feature SHALL 在 macOS arm64/x64 和 Windows x64/arm64 制品中包含匹配的 Go peer，并具备相同连接、配对和清理合约。发布验收 SHALL 记录两个独立物理 peer 的身份、网络拓扑、候选对、DSH 应用检查和业务流量归属；模拟器、编译或本机自连 SHALL NOT 替代跨机器验证。

#### Scenario: Validate supported platform pairs

- **WHEN** 在包含所有支持架构的真实 Windows↔macOS 测试矩阵上执行双向连接
- **THEN** 配对、非默认端口、HTTP/WebSocket、固定标签、断开和崩溃清理均有对应平台证据

#### Scenario: Verify direct traffic across NAT

- **WHEN** 在同 LAN、不同 NAT、IPv6 及禁止 UDP 的受控环境中执行验收
- **THEN** 成功样本记录非 relay 候选对和直传业务流量，不能直连的样本明确失败，服务器仅出现允许的信令/心跳/STUN 流量

#### Scenario: Inspect production packages

- **WHEN** 检查服务器和桌面最终制品
- **THEN** 不含 ZeroTier/libzt、测试 fake/fixture/NAT simulator、真实凭证或错误架构 helper，桌面包不含服务器入口

### Requirement: Pair discovery and local detachment have explicit UI paths

The Launcher SHALL 提供分享配对码和粘贴配对码入口，无需预先手填 deviceId。旧服务失联时 SHALL 提供独立且明确确认的本地忘记操作，记录拒绝旧身份的 tombstone 后清除本服务凭据/记录/标签；SHALL NOT 将其描述为服务端已撤销或恢复旧信任。

#### Scenario: Pair from two fresh user interfaces

- **WHEN** 两台已登记但互不认识的电脑通过 B 分享配对码、A 粘贴、B 批准、A 核对指纹操作
- **THEN** 原始 UI 路径建立正确 pairId；错服务、自身、过期、重用或篡改配对码被明确拒绝，不公开目录

#### Scenario: Forget an unreachable old service

- **WHEN** 用户明确确认忘记失联服务及列出的关联设备
- **THEN** 先停止本地会话并持久拒绝旧信任，成功清理后才移除标签；远端撤销状态为未确认，其他服务/Local/SSH 不变，新登记失败或取消不恢复旧信任

### Requirement: Stream and test lifecycle preserve runtime ownership

The Launcher SHALL 区分单业务流、信令控制面和 peer 数据面故障。测试前 SHALL 提示可能启动并保留远端 DSH，结果 SHALL 明示启动归属；测试取消和结束 SHALL NOT 停止远端受管 DSH。

#### Scenario: A business stream ends normally

- **WHEN** 页面刷新、HTTP 完成、业务 WebSocket 正常结束或单 stream RESET
- **THEN** 仅清理该 stream，peer 和其他流仍可使用，WSS 中断时现有数据面保持到租约到期或真实数据面失败

#### Scenario: Test starts or cancels a cold runtime

- **WHEN** 远端 DSH 未运行，测试分别成功、在启动请求前取消、在远端接受启动后取消，或与其他连接并发启动
- **THEN** UI 预先提示副作用；结果准确区分未启动/已启动保留/原已运行，并发仅一个受管进程，测试通道清理不杀 DSH

### Requirement: Verification covers every specified scenario and user operation

Feature acceptance SHALL 为两项 capability 的每条场景、每个远程操作及编辑允许字段提供可执行用例，包含前置条件、操作、明确断言、身份归属、测试层级和平台证据。用例 SHALL 覆盖成功、无变化/拒绝、部分执行、恢复、过期/并发和重启读回；参数及平台展开项 SHALL 独立记录实际结果。文档校验、仅 HTTP 200、编译或模拟器 SHALL NOT 替代真实行为验收。

#### Scenario: Trace a requirement to complete evidence

- **WHEN** 审核任意规格场景或远程界面操作的验收结果
- **THEN** 能追踪到准确用例、参数/平台、实际测试名/命令、字段与身份断言以及原始 UI/持久化/网络等适用证据，写入行为具备读回验证

#### Scenario: A case or required evidence is missing

- **WHEN** 存在未覆盖场景、跳过/未执行用例、缺测试设备、失败命令、缺原始证据或只通过静态检查
- **THEN** 相应验收与实现任务保持未完成，不能声明功能完整、发布就绪或归档，不能用另一个平台/历史结果代替

### Requirement: Remote project discovery requires explicit target-side authorization

The Launcher SHALL 允许远端用户通过本机界面明确授权、查看与撤销供指定已配对设备浏览的工程根。配对、设备在线或原生 DSH 可达 SHALL NOT 自动授予整盘目录浏览权限。授权根 SHALL 约束 Launcher 的目录选择能力，不宣称替代 DSH Agent 自身的权限/审批或构成进程沙箱。

#### Scenario: Grant and reuse a remote project root

- **WHEN** 远端用户为指定配对授权一个实际存在的工程根，连接方随后打开远程工程选择器
- **THEN** 仅显示当前配对获准的实际根和目录，授权读回保留原设备/根身份；后续选择不要求远端再次弹出系统窗口

#### Scenario: No root is authorized

- **WHEN** 连接方已配对但没有可浏览的授权根
- **THEN** 显示远端尚未授权及所需操作，不猜 HOME、最近工程、磁盘根，不伪装为空目录或连接成功即可全盘浏览

#### Scenario: Revoke a project discovery grant

- **WHEN** 远端撤销一个工程根的浏览授权而连接方仍持有旧列表或引用
- **THEN** 后续列举与打开重新检查授权并拒绝旧引用，显示权限变化；不撤销其他根/其他电脑，不声称浏览授权撤销已停止 DSH 中运行的任务

### Requirement: Project selection browses the remote filesystem in the local UI

The Launcher SHALL 在连接方公开 UI 提供远端电脑标识、原生路径面包屑、目录列表、进入/上级、刷新、选择工程与取消。列表 SHALL 来自目标实际文件系统，具备有界分页与取消；失败、空列表、权限不足与目录删除 SHALL 分别表达。SHALL NOT 把连接方系统文件选择框或本机目录当作远端结果。

#### Scenario: Browse and select a remote directory

- **WHEN** 连接方在一台电脑的固定标签使用选择工程，浏览授权根下目录并确认
- **THEN** UI 展示的电脑/路径和选择引用均属于该远端，远端解析该引用；不打开连接方系统目录弹窗、不复制或改写本机文件

#### Scenario: Handle platform paths and changed directories

- **WHEN** 浏览中文/空格/Unicode 路径、Windows 盘符、大小写差异、已移除或权限变化的目录
- **THEN** 按目标系统规范返回准确路径或明确错误，不由连接方改写分隔符、替换路径或把错误当空目录；未授权 UNC 不触发网络访问

#### Scenario: Reject escaped and stale directory references

- **WHEN** 请求包含路径遍历、越界 symlink/junction、其他 peer/root 的引用，或旧 attempt/runtime generation 引用
- **THEN** 目标在实际解析和操作时拒绝，不能仅靠字符串前缀或客户端按钮校验，不能列举越权内容或打开替代目录

#### Scenario: Cancel or supersede directory browsing

- **WHEN** 用户取消、切换电脑或断线时目录请求尚未完成
- **THEN** 归属请求终止，迟到页不能覆盖新目标/当前面包屑；列表内存受分页上限约束，焦点与重试入口保持可用

### Requirement: Opening projects uses verified native DSH contracts

The Launcher SHALL 核查并记录支持版本的真实 DSH 工程、会话及任务 API，按该版本契约打开远端工程并读回身份。缺能力或版本不兼容 SHALL 明确失败并阻止完整功能发布；SHALL NOT 虚构接口、注入页面脚本、绕过审批或使用通用 shell 冒充工程打开。需要 Harness 改动时 SHALL 先明确跨仓协议和版本任务。

#### Scenario: Open and read back a remote project

- **WHEN** 用户确认当前获授权的远端目录
- **THEN** 只有远端 DSH 实际打开并返回可核对的工程/会话后才显示成功，电脑/路径/工程/会话与远端读回一致；没有同名本地工程替换

#### Scenario: Project opening response is lost

- **WHEN** 远端可能已接受打开请求但连接方未收到结果
- **THEN** 显示结果未确认，按原请求和会话身份读回；无法确认时保留未知结果，不自动重复创建、改选目录或显示成功

### Requirement: Real remote work preserves task and filesystem ownership

The feature SHALL 经真实 DSH HTTP/WebSocket 支持所选远端工程的对话、文件读写和任务执行，保留 DSH 原生权限/审批。电脑、工程和会话归属 SHALL 持续可辨识。SHALL NOT 添加通用远程 shell/文件代理、绕过 DSH 授权或将文件自动同步到连接方。

#### Scenario: Execute work in the selected remote project

- **WHEN** 用户通过公开 UI 在隔离的真实远端工程读取文件、批准修改并执行无外部副作用的验证任务
- **THEN** UI、DSH 记录和独立远端文件/任务读回一致，未修改同名本机或其他 peer 工程，流式输出经真实 WS 返回而非预制数据

#### Scenario: Recover a task after losing the connection

- **WHEN** 任务已接受后断线，用户随后显式重连
- **THEN** 断线期间显示远端结果待确认而不是任务已停止；重连核对设备、runtime、工程/会话/任务并查询原结果，不自动重放写操作或执行命令

#### Scenario: Runtime restart prevents task reconciliation

- **WHEN** 远端 runtime 重启或原任务记录缺失，无法确认旧执行结果
- **THEN** 明示无法确认及可用人工操作，不猜成功/失败/已取消，不复活旧 generation 或将旧任务投射到新工程

### Requirement: Formal releases prove the complete remote workbench

The release SHALL 在完整用户流程、所有必需质量门禁、四架构最终制品及跨机平台验证通过后才公开。验收 SHALL 包含至少一小时真实 DSH 持续会话、多 peer/多流/慢读背压、断线恢复、公开 UI 原始交互 ledger、远端文件/任务独立读回、mock 依赖零可达及包扫描。存在未实现、失败、未测或缺设备证据时 SHALL 阻止正式发布。

#### Scenario: Publish a fully validated remote workbench

- **WHEN** 当前候选的完整流程、质量 verify、平台与最终包检查均通过
- **THEN** 仅提交归属明确的变更，核对标签/版本/提交、四架构 CI 与发布任务并读取实际 Release 资源后才宣布发布完成

#### Scenario: Transport passes but workbench evidence is missing

- **WHEN** Go 双进程通信已通过，但工程选择、DSH HTTP/WS、真实文件/任务、交互或平台证据任一缺失
- **THEN** 结果只算诊断进展，正式发布保持阻塞，不通过隐藏缺功能、历史包或测试 composition 冒充完整交付
### Requirement: A supported client extension selects the exact remote session

The Launcher SHALL load its separately packaged client extension through the supported Harness plugin mechanism. The extension SHALL navigate only its owning guest using public Harness session/workspace services and SHALL return the actual selected identity. Main SHALL bind requests and replies to the registered guest, peer, attempt and runtime generation. It SHALL NOT inject executable scripts, mutate private client stores, broadcast navigation, or create replacement sessions.

#### Scenario: Navigate through the supported client extension

- **WHEN** main requests navigation to a previously verified workspace/session/path in a connected guest
- **THEN** the extension refreshes the public session list, confirms workspace membership and canonical path, selects through the public session service and returns the actual selection for the same request
- **AND** other guests and local sessions remain unchanged

#### Scenario: Reject an incompatible or foreign navigation channel

- **WHEN** the bridge version is absent or unsupported, or the caller/reply belongs to another guest or runtime generation
- **THEN** the operation fails explicitly before accepting a navigation result
- **AND** no arbitrary IPC, credentials or script execution capability is exposed

#### Scenario: Cancel a pending client navigation

- **WHEN** a request times out, the guest unloads, or a later request arrives while navigation is pending
- **THEN** timeout/unload cancels its pending work and a concurrent request reports busy
- **AND** stale sequence numbers cannot repeat navigation or settle another request

#### Scenario: Selection readback does not match the requested project

- **WHEN** the actual selected workspace/session/path differs from the original target
- **THEN** the result is unconfirmed rather than success
- **AND** no guessed path, replacement session or command replay is performed
