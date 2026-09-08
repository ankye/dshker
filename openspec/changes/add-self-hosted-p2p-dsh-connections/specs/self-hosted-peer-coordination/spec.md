## Purpose

为 DSHKer 多电脑用户提供自主部署的 Go 协调服务，负责设备登记、配对授权、在线发现和 NAT 地址/信令交换，使客户端能够在明确的身份和网络边界内建立点对点数据连接。

## ADDED Requirements

### Requirement: Independently deployed Go coordination service

The system SHALL 通过独立 `ankye/dshker-server` 仓库提供 Go 服务端，具有用户/网络/设备管理 HTTPS API、WSS 信令和 UDP STUN 地址发现能力。The system SHALL 要求显式配置服务地址、监听端口、TLS 和持久状态根，且 SHALL NOT 依赖 ZeroTier、NetHopper、OneIsland、NATS、其他项目账号/配置、DSHKer 源码、上层 go.work 或公开协调/STUN 服务。客户端与服务端 SHALL 只通过版本化协议对接，不共享运行时源码依赖。

#### Scenario: Start a configured server

- **WHEN** 操作者提供有效配置、匹配的持久身份和可写状态目录并启动服务
- **THEN** HTTPS/WSS 与 UDP STUN 分别通过就绪检查，客户端可以登记并发起连接协商

#### Scenario: Required deployment input is absent

- **WHEN** 服务地址、TLS、持久身份或已登记数据库不存在、损坏或不匹配
- **THEN** 服务明确失败并指出输入类别，不创建替代身份或切换服务地址

### Requirement: Device enrollment proves local identity ownership

The system SHALL 允许设备凭有效的 networkId 免登录加入网络并登记本机设备身份，把该设备纳入网络的设备目录。登记 SHALL NOT 要求登录：本机设备身份在客户端启动时即已生成，凭 networkId 提交本机公钥持有证明即可登记；登录与授权确认 SHALL 仅在“组网”（建立设备间 DSH 连接）之前要求，不能代替设备 mTLS。设备私钥/证书/密文 SHALL 仅留本机、不上传、不进入 renderer；登记结果 SHALL 原子持久化且可按原设备身份读回，凭证/凭据 SHALL 被原子消费，持久记录中仅保留其不可逆摘要。加入网络 SHALL 受该网络的组网设备数上限约束（见 “Network device capacity is bounded”）。

#### Scenario: Enroll a new device

- **WHEN** 客户端在未登录状态下凭有效 networkId 提交本机公钥持有证明
- **THEN** 服务把该设备登记到该网络，生成稳定 deviceId 并绑定该公钥，设备处于已登记但未组网状态；后续请求要求匹配的设备认证

#### Scenario: Enroll without a network id or over the capacity limit

- **WHEN** 客户端未提供有效 networkId、或该网络已达到组网设备数上限
- **THEN** 登记被拒绝并返回明确错误（缺网络 id / 网络已满），不创建部分登记或可用设备会话

#### Scenario: Reuse or forge enrollment

- **WHEN** 登记结果已消费、请求重复，或请求未证明所提交公钥的私钥持有权
- **THEN** 登记被拒绝且不存在部分登记或可用设备会话，不生成第二个设备身份，不公开其他登记信息

### Requirement: Network device capacity is bounded

The system SHALL 为每个 network 维护组网设备数上限，限制可加入该网络的已登记设备数量。默认上限 SHALL 为 10，服务端 SHALL 允许由网络创建者（已登录、拥有该网络）在客户端编辑时把上限提高到 20 或 30。已达上限的网络 SHALL 拒绝新设备登记并返回明确错误；降低上限 SHALL NOT 静默踢出已登记设备，只能拒绝新增。上限字段 SHALL 属于网络的持久配置，创建网络时确定、编辑网络时读回一致。

#### Scenario: Join a network within the capacity limit

- **WHEN** 客户端凭有效 networkId 登记，且该网络已登记设备数低于上限
- **THEN** 设备被登记并纳入网络设备目录，计数 +1

#### Scenario: Join a network at the capacity limit

- **WHEN** 客户端凭有效 networkId 登记，且该网络已登记设备数等于上限
- **THEN** 登记被拒绝并返回明确的“网络已满”错误，不创建部分登记，不替换或移除既有设备

#### Scenario: Raise the capacity limit

- **WHEN** 网络创建者（已登录且拥有该网络）在客户端编辑网络，把上限从 10 提高到 20 或 30 并保存
- **THEN** 新上限持久化并读回一致，此前因满员被拒的设备可重新登记

### Requirement: Pairing and device visibility require explicit authorization

The system SHALL 将设备已登记、设备在线和双方配对授权作为独立状态。只有完成目标设备批准及发起端指纹确认的配对 SHALL 允许 DSH 连接；邀请 SHALL 在 5 分钟后失效。客户端 SHALL 固定保存已确认的对端公钥，不能按名称或 IP 自动接受新身份。

#### Scenario: Pair two devices

- **WHEN** A 发起邀请、B 明确批准且 A 确认 B 的身份指纹
- **THEN** 双方得到绑定两台设备身份的稳定 pairId，并可在后续连接中复用授权而不用复制私钥或 DSH Token

#### Scenario: Unpaired device attempts access

- **WHEN** 已登记但未配对的设备尝试查询不属于自己的关系或向目标发送连接信令
- **THEN** 服务拒绝访问，不转发请求，也不向其暴露目标会话或凭证

#### Scenario: A device key changes

- **WHEN** 已配对 deviceId 对应的公钥或设备身份与保存值不一致（同公钥、同 deviceId 的合法证书续期不属于身份改变）
- **THEN** 客户端拒绝连接并要求重新配对，不自动更新信任

### Requirement: Management views expose only authorized lifecycle results

The service SHALL 向已认证设备提供本机登记状态、自身发起/收到的配对申请、已授权关系、presence 与撤销结果，支持按准确申请标识批准/拒绝和读取最终结果。未配对设备 SHALL NOT 通过管理界面枚举其他设备或读取无关申请。客户端本地显示名称修改 SHALL NOT 改写远端身份或授权。

#### Scenario: Read and resolve an owned pairing request

- **WHEN** 已认证设备读取属于自身的申请并对仍有效的目标申请批准或拒绝
- **THEN** 只更新该申请并返回权威结果，其他申请和设备关系不变；批准后仍需发起端指纹确认才能完成配对

#### Scenario: Request expired or already changed

- **WHEN** 用户提交过期、已拒绝、已处理或不属于自己的申请
- **THEN** 服务明确拒绝并允许有权限的用户读取实际结果，不创建替代申请或扩大关系可见范围

#### Scenario: Enrollment response is interrupted

- **WHEN** 登记可能已消费凭证但客户端未收到结果，并使用同一本机密钥证明持有权查询本次结果
- **THEN** 服务只返回该公钥对应的登记结果或明确未登记，不再消费凭证、不自动生成第二个设备身份，也不公开其他登记信息

### Requirement: Coordinator endpoint changes preserve service trust

The service SHALL 提供有限的、绑定客户端新鲜挑战的签名身份与端点说明，供已登记客户端在发送设备凭据前验证候选地址仍属于固定服务身份。说明 SHALL 包含协议版本与公告 HTTPS/WSS/STUN 端点，SHALL NOT 包含设备目录、关系、私钥或业务凭证。端点变更 SHALL NOT 隐式更改设备、公钥和撤销关系。

#### Scenario: Verify a new endpoint for the existing service

- **WHEN** 客户端对同一签发身份下的新合法 TLS 端点提交新鲜挑战
- **THEN** 可验证的说明绑定该挑战与实际服务配置，随后匹配设备身份可查询原关系而无需重复配对

#### Scenario: A candidate endpoint cannot prove the pinned identity

- **WHEN** 说明签名无效、身份不同、挑战过期/不匹配、协议不兼容或公告端点与提交配置不符
- **THEN** 客户端拒绝替换，不能将旧设备证书、配对授权或登记凭证交给该候选地址

### Requirement: Authenticated signaling is bounded and isolated from business traffic

The system SHALL 仅在获授权的设备关系内转发版本化、限长、带过期时间和 attempt 身份的协商消息。The system SHALL 检查设备身份、目标关系、签名、序号、过期、协议版本和消息类型；SHALL NOT 通过信令端点传递 DSH 内容、DSH Token、远端目录/工程列表、文件正文、任务请求/输出或任意业务二进制流。工程根浏览授权及工程/任务执行由远端 Launcher/DSH 所有，SHALL NOT 移到 coordinator 或要求其依赖客户端源码。

#### Scenario: Exchange valid negotiation messages

- **WHEN** 双方使用有效设备身份与配对授权提交同一 attempt 的合法 offer、answer 和 candidate
- **THEN** 服务只将这些消息发送给该 attempt 的另一台设备，记录不含 SDP/ICE 凭证正文的审计事件

#### Scenario: Replay or cross-device injection

- **WHEN** 消息超长、过期、重复、未知版本、伪造 sender、跨 attempt 或发往无授权设备
- **THEN** 服务返回对应错误并不转发消息

#### Scenario: STUN request is received

- **WHEN** 合法且在限流预算内的 Binding 请求抵达配置的 UDP 端口
- **THEN** 服务只返回请求源地址的观测结果，不将其解释成配对或已连接，不提供 TURN Allocate 或通用转发

### Requirement: Presence and revocation have explicit freshness

The system SHALL 将超过 30 秒未收到心跳的设备标记 stale。会话授权 SHALL 绑定 userId、networkId、pairId、双方身份、attemptId 和撤销版本，最多有效 60 秒；客户端 SHALL 每 20 秒续期，收到撤销立即关闭业务流，无法续期时最迟在租约到期关闭。离线/过期设备 SHALL NOT 被视为可建立新连接。禁用账号、删除网络、解绑成员和删除配对 SHALL 拒绝相关后续信令与续租；重绑不能恢复旧配对。

#### Scenario: Revoke a connected peer

- **WHEN** 用户撤销一台设备的配对授权
- **THEN** 服务持久化撤销、拒绝新协商，并推送关闭事件；未能接收推送的旧会话也最迟在其 60 秒租约到期时关闭

#### Scenario: Coordination server becomes unavailable

- **WHEN** 客户端无法联系配置的协调服务器
- **THEN** 新连接明确失败，已有直连在其有效租约内保留并在不能续期时关闭，不转入其他服务或中继

### Requirement: Persistent state survives restart with matched identity

The system SHALL 事务持久化设备关系、配对公钥和撤销状态，将在线状态及临时信令保留为有期限的内存状态。部署 SHALL 提供匹配服务身份的备份恢复与版本检查，不将私钥或真实凭证加入制品。

#### Scenario: Restart after paired use

- **WHEN** 服务使用匹配的数据库版本和签发身份重启
- **THEN** 已批准和已撤销关系保持不变，所有设备在线状态需重新通过认证心跳确认

#### Scenario: Restore an incompatible backup

- **WHEN** 备份 schema 或签发身份与部署版本不匹配
- **THEN** 服务停止恢复并报告原因，不清空数据库或生成新身份继续运行

#### Scenario: Restore a pre-revocation backup

- **WHEN** 操作者显式 recover 同 schema/同原签发身份、但早于一次撤销的备份
- **THEN** 在新目标中生成新服务身份并作废全部旧设备证书/配对/邀请；旧凭证不能获得新租约，客户端必须重新登记配对；不能沿用旧签发身份透明恢复授权

### Requirement: Device certificates renew without replacing paired identity

The service SHALL 签发 30 天设备证书，允许剩余 7 天且未撤销设备用有效 mTLS 与同密钥 CSR 续期。续期 SHALL 保留 deviceId/公钥/pairId，按 requestId 幂等读回；SHALL NOT 信任变更的密钥或仅按证书 serial 标识设备。过期恢复 SHALL 要求设备所属用户为其已绑定的有效网络申请新单次凭证及同密钥持有证明，不能解除账号/设备撤销或恢复已删除网络。

#### Scenario: Renew a paired device certificate

- **WHEN** 未撤销设备使用同密钥在续期窗口提交请求，或在回复丢失后查询同 requestId
- **THEN** 得到同一续期结果且 deviceId/公钥/pairId 不变，固定标签不重建；旧证书到期前仍可认证

#### Scenario: Recover an expired certificate or reject revoked identity

- **WHEN** 设备证书过期、设备已撤销、CSR 密钥变化或重复使用恢复凭证
- **THEN** 只有未撤销设备的新单次凭证及原密钥证明可恢复原身份；其他请求明确失败，不恢复旧撤销授权
