## Why

多电脑 DSHKer 用户需要部署自己的 Go 连接协调服务器，让 macOS 与 Windows 上的 DSHKer 完成设备配对后直接通信，不再为每台电脑手动准备 SSH 登录、转发端口和复制 DSH Token。用户指定的 ZeroTierOne 仓库仅用于参考节点发现与 NAT 穿透思路；本项目自主实现 Go 服务端和 DSHKer 客户端集成，不引入 ZeroTier 网络、Controller、Planet、Moon 或 libzt。

## What Changes

- 交付完整远程工作台闭环：配对电脑 → 认证连接 → 浏览获授权的远端目录 → 选择/打开远端工程 → 使用真实 DSH 对话、读写工程文件和执行任务 → 断线后查询并恢复原会话。用户不需要打开 SSH 服务、手写端口转发或复制 DSH Token；仅底层传输可用不得作为功能完成发布。
- 远程工程选择在当前电脑呈现远端目录，明确显示目标电脑、远端原生路径与权限范围；不弹出本机选目录窗口冒充远端选择，不要求用户跑到远端确认每次选择。允许浏览的根由远端用户事先明确授权，配对不自动授权整个磁盘；无权限、空目录、不可达、目录已移除分别反馈。文件不会自动同步到本机。
- 工程、会话、任务结果均由远端 DSH 权威读回。连接中断不等于远端任务停止，结果未确认时不自动重发写操作或执行任务；重连先核对身份与原任务结果，避免重复执行或将远端结果展示在 Local。
- 新增显式选择的 P2P 连接模式：配置自建服务、登记本机、批准设备配对、测试、连接、断开和撤销配对；原 SSH 连接模式保持独立，不自动切换。
- 在左侧“远程连接”Tab 完整承载服务器配置、本机登记、配对申请和电脑列表操作；同时补齐 SSH 与 P2P 编辑表单、保存/取消、校验、操作进度和错误恢复，而非只提供底层 API。
- SSH 支持修改显示名称、主机、SSH 端口和用户名；P2P 支持修改本地显示名称及所属协调服务器配置。仅改名称不打断连接；修改连接参数必须先断开受影响连接，保存成功后旧测试结果失效。身份、公钥与配对关系不能作为普通字段替换，身份变更要求重新登记/配对。
- 编辑失败保留输入与原配置，禁止部分覆盖；固定浏览器标签同步显示名称，断线页提供重连和编辑入口，编辑不通过删除重建记录实现。
- 自研 Go coordinator，提供 HTTPS 设备登记/配对/撤销 API、WSS 在线状态与信令交换、UDP STUN 地址发现。首期在一台公网 Linux 服务器上部署，明确单点故障，不宣称高可用。
- DSHKer 内置 Go peer helper，采用 Pion WebRTC 的 ICE + DTLS + DataChannel 建立可靠加密直连；使用协议库，不自行发明 NAT 穿透和加密协议。无系统虚拟网卡、全局路由修改或 SSH 服务依赖。
- 新 P2P 模式仅使用用户明确配置的自建 coordinator/STUN；不使用公共信令、公共 STUN 或中继服务，不因配置缺失选择其他服务或 SSH。
- 建立认证直连后，远端 DSHKer 读取自己的当前 DSH 启动公告，传递会话连接信息；请求端通过限定用途的本地 loopback 入口加载远程 DSH，支持 HTTP、Cookie 与 WebSocket，适配动态端口和重启。
- 保留一个不可关闭的 Local 标签、每台已登记电脑一个固定标签。分别显示设备在线、连接阶段、实际路径和 DSH 就绪；只有完成认证直连与 DSH 验证才显示绿色，失败显示红色并给出阶段化错误。
- 强制业务数据直连：仅允许非 relay ICE candidate，不部署 TURN，不通过 WSS 搬运 DSH 数据。打洞失败明确报告 `p2p.direct_unavailable`；服务器在线或信令成功不能计为直连成功。
- 验证真实 macOS↔Windows 打洞、设备身份与 DTLS 会话绑定、DSH HTTP/WebSocket 桥接，以及四架构 helper 构建；根据选中的 ICE candidate pair 和服务器/客户端流量记录证明数据路径。
- 完整测试用例随规格维护：每条 Scenario、远程操作、编辑事务、并发/失败/恢复和旧 Local/SSH 回归均有前置条件、步骤、断言及平台/证据要求。未执行或缺真实平台证据不得计为通过。

**Non-goals:** 通用 VPN、全局代理、局域网路由、文件同步、远程桌面、通用文件/命令代理、无人确认的设备互信、复制私钥、保证所有 NAT 环境均能直连、部署业务中继或猜测服务器部署凭据。经过授权的远端工程浏览与 DSH 原生工程操作属于必交范围，不在此排除。

## Delivery Contract

用户已授权更新后实施并发布。正式 Release 必须基于完整远程工作台实现、真实公开 UI 操作及远端文件/任务读回、故障恢复、四架构最终包和跨机验证。按 quality-engineering 维护 interactive manifest、不可弱化的交互合约、原始 ledger、全部改动文件与字段/身份绑定，执行默认 verify。不得用先前 Go 双进程、仅 HTTP 200、截图、交叉编译或历史 Release 代替当前候选验收；不完整阶段不向普通用户宣称功能已交付。实际部署目标及无法访问的物理机证据缺失时保持发布阻塞，不制造证明。

## Capabilities

### New Capabilities

- `self-hosted-peer-coordination`: 自研 Go 协调服务部署、STUN/信令、设备登记/配对/撤销、控制面权限与运行证据。
- `direct-peer-dsh-sessions`: DSHKer 用户态 peer 生命周期、仅直连应用隧道、动态 DSH 会话桥接、获授权远端目录/工程选择与任务恢复，以及远程操作界面、SSH/P2P 显式编辑、固定标签、状态与完整跨平台验收。

### Modified Capabilities

None. 当前主规格目录尚无可引用的已归档能力。与 `add-managed-remote-dsh-connections` 的关系是新增显式 P2P 模式及用户批准的远程记录编辑能力；该变更内关于必须 SSH 的条款继续约束 SSH 模式。SSH 原传输、认证和 catalog 格式不变，只有明确编辑操作可更新选定 SSH 记录；不进行隐式迁移。编辑需求记录在本变更的远程会话 capability 内。已有源码/插件/配置根、版本激活、脏目录拒绝等本地 Harness 合约保持原变更所有权。

## Impact

- **DSHKer repository（客户端所有者）:** `networking/` 只保留 peer helper 与客户端协议，扩展 Electron typed IPC、远程连接域、Run guest 和四平台打包。服务器代码、账号和数据库不进入桌面仓库或安装包。
- **独立服务器:** `ankye/dshker-server` 拥有 Gin HTTPS API、WSS/STUN、用户/网络/设备绑定/配对认证，以及自身 go.mod、SQLite、单二进制和部署文档。服务器实现由 `add-dshker-user-networks` 跟踪。两个项目不通过源码 import 或本地 replace 关联，不接入 NetHopper、OneIsland、NATS、共享账号或配置。
- **ZeroTierOne repository（只读参考）:** 已检查 checkout `899352e38` 的发现、打洞和中继边界；不复制其实现、不修改该仓库、不产生运行时或构建依赖。
- **New dependencies:** 固定版本的 Go、Pion WebRTC/STUN 及传递依赖；在实现时通过 `go.mod` / `go.sum`、许可证清单和制品清单记录，不使用 latest 浮动构建。
- **DeepSeek Harness:** 继续由远端 Launcher 启动受管 DSH、绑定 loopback、使用原生会话 Token。实施前核查所支持版本的真实工程/会话/任务接口与目录选择行为，不能假定隧道自动支持原生选目录弹窗。复用经核实的能力；若必须修改 Harness，先明确所属仓库、兼容协议、版本/打包矩阵和跨仓任务，不用注入脚本、伪 API 或通用 shell 绕过缺口。
- **Deployment inputs:** 公网服务器、域名、部署路径、TLS、组织授权和许可依据尚未提供，均是后续部署的显式输入。用户已授权优化后实施，本地实现先行；实际部署与跨机验收不得猜测这些输入。
