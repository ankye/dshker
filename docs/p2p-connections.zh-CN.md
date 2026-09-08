# 自托管 P2P 远程工作台（开发中）

在你自己的两台电脑之间建立直连，从一台打开另一台的 DSH 工作台，无需把 DSH Web
暴露到网络，也不需要 SSH 隧道。

> **状态：尚未发布。** 桌面端实现与自动化测试已完成，但双机验收、四架构安装包
> 与协调服务器部署尚未执行。请不要把本文当作"该功能已在正式版本中可用"的说明。
> 安装包构建成功不等于发布成功。

## 这个功能是什么，不是什么

它**是**：由你自己托管的协调服务器牵线，在你控制的两台电脑之间建立直连。

它**不是**：

- 任意网络都能连通的方案。直连需要可用的 UDP 路径。某些网络无法穿透——两端都是
  对称 NAT、UDP 被完全封锁、企业出口严格限制。**本功能不使用中继**，因此在这类
  网络中会报 `direct_unavailable` 并失败，而不会悄悄绕经第三方的慢速通道。
- DSH 的沙箱。授权目录只限制本应用里的目录选择器。工程打开之后，对话、文件读写
  和任务仍由**对方电脑上** DSH 自身的权限与审批策略控制。本应用不绕过、也不削弱它。
- 文件管理器或远程终端。远端操作只有两项：列出授权目录、打开其中的工程。

## 开始之前

需要准备三样东西：

1. **一台你自己托管的协调服务器**，见
   [DSHKer Server](https://github.com/ankye/dshker-server)。它需要有效的 HTTPS
   证书、WSS 信令端点，以及可达的 STUN UDP 端口。证书或配置问题必须在服务器侧
   解决；桌面端会主动拒绝连接无法验证的服务器。
2. **两台电脑**，各自运行本应用，并登录同一台服务器上的同一账号。电脑无法与自己配对。
3. **被打开的那台电脑上 DSH 能够运行。** 远端负责承载真正的工作台；如果它的 DSH
   起不来，配对会成功，但连接不会产出可用的工作台。

## 开始之前：先跑预检

首次测试最常卡在两件事上：本机没有可用的 peer helper，或者协调服务器实际不可达。
配对之前先检查这两项：

```
npm run p2p:preflight
```

上面只检查本机 helper。要一并检查服务器：

```
node tools/p2p-preflight.mjs \
  --https https://your-server.example \
  --wss   wss://your-server.example/v1/signals \
  --stun  your-server.example:3478
```

加 `--json` 可输出机器可读格式。任一检查失败时退出码非零；该工具不发送任何凭据，
也不修改任何状态。

各类失败的含义：

- **helper 缺失或校验和不符。** 每台机器必须为自己的架构各自构建 helper，不能从
  别的机器拷贝。失败信息里会直接给出该跑的命令。
- **TLS 证书不受信。** 请在服务器侧解决。应用会主动拒绝无法验证的服务器，因此本机
  不信任的自签名证书是连不上的。
- **STUN 无响应。** UDP 被封锁或端口未开放。这正是"配对成功但连接报
  `direct_unavailable`"最常见的原因。本功能没有中继，必须修好而不能绕过。

STUN 通过只能证明本机能通过 UDP 到达服务器，**不能**证明两台电脑之间可以互通；
只有真正连接一次才能证明。

## 1. 添加服务器

打开**远程连接 → P2P**，添加服务器：

| 字段          | 含义                                     |
| ------------- | ---------------------------------------- |
| 名称          | 仅在本机显示。修改它不会影响另一台电脑。 |
| HTTPS 地址    | 读写账号、网络与配对记录的地址。         |
| 信令 WSS 地址 | 两台电脑交换连接信息的地址。             |
| STUN 地址     | 用于发现直连路径。                       |

应用会在首次验证时**固定**服务器身份。若同一地址之后出现**不同身份**，连接会被
拒绝而不是重新信任——这是刻意设计，正是它能防止服务器被替换。

移除服务器会在本机将其永久标记为不可信，之后重新添加同一身份会被拒绝。因此请仅
在确实需要时才移除。

## 2. 登记本机并登录

使用服务器账号登录，然后把本机登记为设备。设备密钥在本地生成，不会离开这台电脑。
根据服务器配置，登记可能需要审批；**待审批不等于已批准**，应用会如实说明，而不会
显示绿色的就绪状态。

## 3. 配对两台电脑

配对刻意设计为双方显式参与，任何一方都无法单方面完成配对。

1. 在电脑 **A** 上创建邀请。邀请码**只显示一次**。它是密钥：请通过你信任的渠道
   带外传递（可信的消息或手动输入），不要贴到任何公开位置。它不被保存，也无法再次查看。
2. 在电脑 **B** 上接受邀请。此时**配对尚未完成**。
3. 回到电脑 **A** 审核请求。你会看到由 B 的**真实设备密钥**派生出的**指纹**。
   将它与 B 上显示的指纹逐位比对。
4. **只有**指纹一致时，才输入确认文字批准。若不一致请拒绝：不一致意味着你正要
   批准的密钥并不是 B 实际持有的密钥。

批准后双方都会显示该配对为活动状态。如果某次写入结果不明（例如请求中途断网），
应用会阻止后续写入并要求你重新读取状态。这是刻意的：它不会去猜你的批准是否生效。

## 4. 连接并打开工程

1. 在已配对的电脑上选择**连接**。你会看到这些阶段：_正在尝试直连_ →
   _正在启动远端运行时_ → _已连接_。只有**已连接**才表示工作台可用；中间阶段
   不是连接，应用也不会把它们当作连接来展示。
2. 在 **Run** 下，这台电脑有自己固定的标签页。
3. 读取对方的**授权目录**，选择其中之一并浏览。目录名来自对方电脑；目录结构由
   对方按其自身系统规则解析。
4. 选择工程并打开。

每台电脑使用**独立隔离的浏览器会话**。某个远端工作台的 Cookie 与令牌，绝不会与
另一台电脑、Local 或 SSH 连接共用。重命名电脑不会改变这种隔离。

### 关于授权目录

由**对方**电脑的使用者决定哪些目录可被列出，你无法从本侧添加。任何试图访问该范围
之外位置的行为——包括通过指向外部的符号链接或 junction——都会被拒绝，而不是被
悄悄重定向。

## 5. 编辑电脑或服务器

这是两种不同的作用范围，区别很重要：

- **电脑名称**仅作用于本机。随时改名都是安全的，不会中断已有连接，也不会重载其标签页。
- **服务器配置是共享的**，由通过该服务器配对的所有电脑共用。修改会影响它们全部，
  因此只要其中任一台正忙，应用就会拒绝保存。请等它们空闲。

保存新的服务器地址时，该地址必须证明自己仍是**同一个**已固定身份。若不能，保存会被
拒绝，且已存储的配置保持原样。成功修改后，此前的连接测试结果不再适用，需要重新测试。

保存失败时你输入的内容会被保留，无需重新输入。若结果不明，应用会提示你重新读取
配置核对，而不是让你再保存一次。

## 6. 撤销访问

撤销配对可阻止某台电脑再次连接。记录仍会保留以便你了解它为何失效，但它无法再连接；
如需恢复请重新配对。

撤销只影响该配对，Local 与其他所有电脑照常工作。如果服务器侧撤销成功但本地记录
删除失败，该电脑会显示为已撤销，而不会报告为已完全移除——应用不会声称它没有完成
的清理。

## 断线之后：请核对你的任务

这一节最容易造成误解，值得仔细阅读。

**连接断开并不能说明你的任务发生了什么。** 远端任务可能已完成、可能仍在运行、也
可能已失败。因此本应用会：

- 区分*连接丢失*、_结果未知_、*远端运行时已被替换*三种情况；
- **绝不**自动重试、重新提交或取消任何操作；
- **绝不**推断或显示它未曾观测到的任务状态；
- **不会**因为连接恢复就清除警告。重连不构成对先前任务的证据。

请在对方电脑的 DSH 上核对真实结果，然后手动标记为已核对。

## 故障排查

按你卡住的步骤查，而不是按错误码字母序。同一个码在不同步骤含义相同，但该做的事不同。

### 装不上 / 起不来

| 错误码                                               | 含义与处理                                                                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `p2p.helper_platform_unsupported`                    | 当前系统或架构不支持。仅支持 macOS 与 Windows 的 arm64/x64。                                                                                                   |
| `p2p.helper_resource_unavailable`                    | 找不到本机架构的 helper。**每台机器要各自构建**，不能从别的机器拷。跑 `node tools/build-peer-helper.mjs --platform <darwin\|win32> --arch <arm64\|x64>`。      |
| `p2p.helper_integrity_failed` / `p2p.helper_invalid` | helper 与 manifest 校验和不符，或不是普通文件。删掉 `build/p2p/` 下对应目录重新构建。                                                                          |
| `p2p.secure_storage_unavailable`                     | 系统安全存储不可用，凭据无法加密保存，因此登录会被拒绝。Windows 上通常是账户或策略限制了 DPAPI；请用正常登录的桌面会话运行，不要在服务账户或无桌面会话下运行。 |
| `p2p.settings_root_required`                         | 尚未确定设置目录。先完成 Launcher 首次启动流程。                                                                                                               |
| `p2p.not_enabled`                                    | 本机尚未显式启用 P2P。在**远程连接 → P2P** 中启用。                                                                                                            |

### 加服务器 / 登录

| 错误码                                                                                       | 含义与处理                                                                                                              |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `p2p.invalid_service_endpoint` / `p2p.invalid_signal_endpoint` / `p2p.invalid_stun_endpoint` | 地址格式不合要求。HTTPS 必须 `https:`，信令必须 `wss:`，STUN 为 `主机:端口`。先用 `node tools/p2p-preflight.mjs` 验证。 |
| `p2p.invalid_service_identity` / `p2p.identity_mismatch`                                     | 服务器出示的身份与已固定的不一致。**不要批准。** 确认你连的是正确服务器；若确实更换了服务器身份，需要重新建立信任。     |
| `p2p.server_unavailable`                                                                     | 服务器不可达或未响应。用预检确认 HTTPS/WSS/STUN 三项。                                                                  |
| `p2p.trust_restore_rejected`                                                                 | 该服务器身份此前被你移除过，已永久标记不可信。这是刻意的，不能撤销。                                                    |
| `p2p.service_exists`                                                                         | 该地址已被另一条服务器记录占用。                                                                                        |
| `p2p.user_login_required` / `p2p.user_session_expired`                                       | 未登录或会话过期。重新登录。                                                                                            |
| `p2p.user_already_logged_in`                                                                 | 已有登录会话。先登出再切换账号。                                                                                        |
| `p2p.user_unauthorized` / `p2p.user_scope_mismatch`                                          | 账号无权访问该资源，或资源属于别的账号。确认两台机器登录的是**同一账号**。                                              |

### 登记设备

| 错误码                                                                          | 含义与处理                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `p2p.device_unregistered`                                                       | 本机还没登记为设备。先完成登记。                                         |
| `p2p.enrollment_not_found` / `p2p.invalid_enrollment_grant`                     | 登记请求不存在或授权无效，通常是超时或已被处理。重新发起登记。           |
| `p2p.enrollment_state_mismatch` / `p2p.invalid_device_state`                    | 登记状态与你的操作不匹配，通常是另一端已推进了状态。重新读取后再操作。   |
| `p2p.enrollment_result_unconfirmed`                                             | 登记结果**未确认**，可能已生效。重新读取登记状态核对，**不要**直接重试。 |
| `p2p.invalid_device_key` / `p2p.invalid_csr` / `p2p.invalid_device_certificate` | 设备密钥或证书材料无效。这属于异常情况，请把完整错误发我。               |

### 配对

| 错误码                                           | 含义与处理                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `p2p.invite_invalid`                             | 邀请码无效——输错、已被用过，或不属于该服务器。重新生成邀请。邀请码只显示一次。               |
| `p2p.invite_expired` / `p2p.pair_expired`        | 邀请或配对请求已过期。重新发起。                                                             |
| **指纹不一致** / `p2p.pair_fingerprint_mismatch` | 你正要批准的密钥**不是**对方实际持有的密钥。**拒绝**并重新开始。这是防身份替换的最后一道关。 |
| `p2p.pair_state_mismatch`                        | 配对状态与操作不匹配，通常是对方已批准或已撤销。重新读取后再操作。                           |
| `p2p.pair_not_found`                             | 配对已失效，通常是对方撤销了。如仍需访问请重新配对。                                         |
| `p2p.management_result_unconfirmed`              | 写入结果**未确认**，可能已生效。重新读取记录核对，**不要**重复提交。                         |

### 连接

| 错误码                                                         | 含义与处理                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `direct_unavailable`                                           | 两个网络之间没有可用的直连 UDP 路径。**本功能不使用中继**，这种网络就是连不上。这是限制而非缺陷。 |
| 长时间停在*正在尝试直连*                                       | 信令或 STUN 不可达。用预检确认 WSS 与 STUN。                                                      |
| `p2p.not_connected`                                            | 该操作需要已连接。先连接。                                                                        |
| `p2p.connection_busy` / `p2p.helper_busy` / `p2p.service_busy` | 有操作正在进行。等它结束，**不要**反复点击。                                                      |
| `p2p.stale_generation` / `p2p.attempt_mismatch`                | 旧的连接尝试的回调到达。这是**正常的防护**，旧尝试不能复活新连接；重新连接即可。                  |
| 已连接但工作台加载不出来                                       | 远端 DSH 未启动。检查对方电脑上的 DSH。                                                           |
| `p2p.helper_unavailable` / `p2p.helper_closed`                 | 本机 helper 进程不可用或已退出。重启 App；若反复出现请发我日志。                                  |
| `p2p.helper_authentication_failed`                             | helper 私有通道认证失败。这属于异常情况，请发我完整错误。                                         |

### 浏览远端目录 / 打开工程

| 错误码                         | 含义与处理                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `p2p.remote_roots_unavailable` | 对方无法报告其授权目录。确认它仍在连接、App 仍在运行。                                  |
| `p2p.remote_root_unauthorized` | 该目录不在对方授权范围内。                                                              |
| `p2p.remote_path_forbidden`    | 该位置在授权目录之外（含指向外部的符号链接）。**这不代表目录为空。** 请对方授权该目录。 |
| `p2p.remote_path_missing`      | 该位置在对方电脑上已不存在。                                                            |
| `p2p.remote_reference_invalid` | 目录引用无效或已过期。返回授权目录根重新进入。                                          |
| `p2p.remote_directory_failed`  | 对方读取目录失败（权限、卷已卸载等）。在对方电脑上检查该目录。                          |

### 编辑配置

| 错误码                                               | 含义与处理                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `p2p.service_busy`                                   | 共用该服务器配置的某台电脑正在操作中。等其空闲后重新保存。         |
| `p2p.catalog_conflict`                               | 记录已被其他操作更改。重新读取后再应用你的修改。你的输入会被保留。 |
| `p2p.service_not_found` / `p2p.connection_not_found` | 目标记录不存在，通常是已被移除。重新读取列表。                     |

### 存储与内部错误

这些通常意味着环境问题或缺陷，遇到请把完整错误发我：

`p2p.catalog_invalid`、`p2p.catalog_incomplete`、`p2p.catalog_unavailable`、
`p2p.catalog_write_failed`、`p2p.catalog_exists`、`p2p.credential_invalid`、
`p2p.credential_unavailable`、`p2p.credential_write_failed`、
`p2p.credential_create_failed`、`p2p.credential_conflict`、
`p2p.credential_cleanup_failed`、`p2p.authorization_cleanup_failed`、
`p2p.helper_cleanup_failed`、`p2p.helper_shutdown_failed`、
`p2p.helper_parent_unavailable`、`p2p.insecure_socket_directory`、
`p2p.invalid_socket`、`p2p.internal_error`、`p2p.operation_failed`、
`p2p.invalid_server_response`、`p2p.invalid_payload`、`p2p.protocol_mismatch`、
`p2p.protocol_limit`、`p2p.partition_mismatch`、`p2p.runtime_request_unscoped`、
`p2p.ipc_invalid_sender`、`p2p.request_replayed`、`p2p.request_limit`、
`p2p.invalid_peer_state`、`p2p.invalid_user_session`、`p2p.invalid_network_list`、
`p2p.network_unavailable`、`p2p.service_unconfigured`、`p2p.invalid_operation`、
`p2p.invalid_request`、`p2p.request_unavailable`、`p2p.request_timeout`、
`p2p.request_cancelled`、`p2p.attempt_not_found`、`p2p.binding_unauthorized`、`p2p.certificate_not_expired`、`p2p.config_unavailable`、`p2p.device_already_enrolled`、`p2p.device_busy`、`p2p.device_unauthorized`、`p2p.explicit_absolute_path_required`、`p2p.identity_unavailable`、`p2p.invalid_challenge`、`p2p.invalid_config`、`p2p.invalid_content_type`、`p2p.invalid_database`、`p2p.invalid_endpoint`、`p2p.invalid_enrollment`、`p2p.invalid_enrollment_token`、`p2p.invalid_generation`、`p2p.invalid_https_origin`、`p2p.invalid_identity`、`p2p.invalid_name`、`p2p.invalid_pair_action`、`p2p.invalid_signal_origin`、`p2p.invalid_stun_binding`、`p2p.invalid_user_credentials`、`p2p.invalid_wss_endpoint`、`p2p.login_failed`、`p2p.network_unauthorized`、`p2p.pair_revoked`、`p2p.pair_state_conflict`、`p2p.pairing_busy`、`p2p.pairing_expired`、`p2p.path_conflict`、`p2p.peer_offline`、`p2p.rate_limited`、`p2p.renewal_not_due`、`p2p.request_conflict`、`p2p.request_interrupted`、`p2p.sdp_binding_mismatch`、`p2p.signal_limit`、`p2p.state_already_exists`、`p2p.state_unavailable_or_insecure`、`p2p.tls_required`、`p2p.tls_unavailable`、`p2p.unknown_operation`、`p2p.unsupported_schema`、`p2p.user_conflict`、`p2p.user_not_found`、`p2p.connection_cancelled`、`p2p.credit_exhausted`、`p2p.destination_rejected`、`p2p.direct_closed`、`p2p.direct_unavailable`、`p2p.duplicate_field`、`p2p.explicit_stun_required`、`p2p.frame_scope_mismatch`、`p2p.helper_configuration_required`、`p2p.helper_listen_failed`、`p2p.helper_user_unavailable`、`p2p.identity_not_verified`、`p2p.insecure_socket`、`p2p.invalid_bootstrap`、`p2p.invalid_candidate`、`p2p.invalid_credit`、`p2p.invalid_fields`、`p2p.invalid_frame`、`p2p.invalid_json`、`p2p.invalid_pairing_code`、`p2p.invalid_result`、`p2p.invalid_sdp`、`p2p.invalid_stream_sequence`、`p2p.lease_expired`、`p2p.lease_scope_mismatch`、`p2p.listener_unavailable`、`p2p.missing_field`、`p2p.network_full`、`p2p.invalid_network_limit`、`p2p.network_revoked`、`p2p.null_field`、`p2p.pair_unauthorized`、`p2p.receive_limit`、`p2p.redirect_rejected`、`p2p.runtime_generation_mismatch`、`p2p.runtime_http_failed`、`p2p.runtime_invalid`、`p2p.runtime_invalidated`、`p2p.runtime_unavailable`、`p2p.runtime_websocket_failed`、`p2p.send_limit`、`p2p.signal_expired`、`p2p.signal_scope_mismatch`、`p2p.signal_state_conflict`、`p2p.stream_closed`、`p2p.stream_failed`、`p2p.stream_finished`、`p2p.stream_id_exhausted`、`p2p.stream_limit`、`p2p.stream_reset`、`p2p.streams_closed`、`p2p.unexpected_data_channel`、`p2p.unknown_stream`、`p2p.catalog_incomplete`

带 `_cleanup_failed` 的码有个共同点：**主操作已成功，但清理没做完**。App 会如实显示这种部分成功，而不会假称完全完成。

### 三条通用原则

- **测试失败 ≠ 连接失败 ≠ 任务失败。** 三者是不同事件，排查时请分开判断。
- **凡是 `_unconfirmed`（结果未确认）的，先读回核对，不要重试。** 重复提交可能造成重复生效。
- **凡是 `_busy` 的，等待而不是反复点。**

## 服务器升级与备份

协调服务器保存着你的账号、网络、设备登记与配对记录。丢失它意味着所有电脑都需要
重新登记与配对。

升级之前：

1. 停止服务器。
2. 备份其数据目录**以及** TLS 材料，并验证备份可读——未经验证的备份不算备份。
3. 升级后启动，并**分项**确认 HTTPS、WSS、UDP 三项健康检查。三项必须全部通过，
   通过两项即为部署失败。
4. 从桌面端确认既有配对仍可连接。

记录格式变更后不支持降级，请恢复对应的备份。

请保持桌面端与服务器版本兼容：应用会检查协议版本，对无法验证的能力直接报错而不是
猜测。
