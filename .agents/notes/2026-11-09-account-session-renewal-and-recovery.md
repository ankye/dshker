# 登录续期与原账号密码恢复

## 后续明确授权的生产账号维护

用户在后续消息明确指定原邮箱及新密码，授权实际改密。线上仍为 schema7，重设 HTTP 接口尚未部署；没有临时执行会自动迁库的新 CLI。通过已有管理员身份执行受控单账号维护：停止原服务并确认进程/监听结束，以 SQLite backup API 保存权限受限的一致备份，在事务中只更新该 enabled 原账号的 bcrypt BLOB、删除其10个旧登录会话并追加固定审计事件。事务内核对其他用户及会话、全部其他数据表、原账号字段、schema、服务身份、程序/配置/密钥/TLS 文件指纹保持不变，然后启动原二进制。

可信 HTTPS 新密码登录及 current-user 读回确认原账号身份，网络1个、设备2台、配对1组均可读；验证专用会话已明确 logout。最终只读核对原账号不变、旧会话0、schema7、原服务 active。此操作不部署自动续期或新的重设协议。敏感密码、bcrypt 值和 token 未写入日志、代码或本记录；权限受限的操作收据保留在 ignored `.run/account-session-recovery/production-password-reset.json`。

用户授权实现自动续期和密码重设，保留原账号、设备、网络和配对。此次实现跨独立 DSHKer Server 和 Launcher，协议见同名 OpenSpec change。

采用服务器拥有的30天会话、main-only显式续期和管理员签发的15分钟一次性恢复码。无邮件服务、无密码落盘、无过期认证绕过、无替代账号。Go 核心先保存读回服务器期限，Electron 不写回捕获的旧期限；迟到回复受账号与生命周期约束。

生产账号、原凭据、当前运行的已安装应用及远端部署不被源码实现直接修改。管理员应核验原账号所有权后签发恢复码，用户自行输入和提交新密码。发布和真实账号改密需记录为独立结果，不能用源码测试替代。

源码验证和真实服务链路结果见下文；当前不宣称 Windows/macOS 原生逐帧或生产部署验收。

## 主代理集成验证

桌面全量 Vitest 最近完整运行通过 209 个文件、2046 项测试，另有1文件/2项既有平台跳过。之后安全存储错误展示和清理恢复的新增改动执行相关用例回归，不将重叠次数相加。环境、类型、格式、架构、service/visual smoke、renderer/Electron build、父 workspace 应用验证、源码大小和两侧 OpenSpec strict 均通过。构建输出扫描未发现测试路径或测试实现标记，记录于 ignored `.run/account-session-recovery/build-isolation.json`；此证据针对 source production build，不代表已构建或安装发行包。

主代理独立审阅专属 renewal scope 的 stale-expiry、精确 durable record、local revocation owner、prior guard 与生命周期约束，普通选中账号 scope 不借用该宽限；续期服务端鉴权、持久 readback 和登出迟到回复保护成立。

完整互动 default verify 的真实 `-race` 服务集成通过，随后因缺少 `.run/account-session-recovery/interaction-ledger.jsonl` 明确失败；不把 static 结果或组件测试当成原生逐帧验收。隔离源码应用通过公开 Remote Connections → Account → Forgot password 控件确认重设表单可见，未输入新密码或修改真实账号。该空 profile 的既有 device.createKey 初始化出现 `p2p.secret_write_failed`，不是完整功能 smoke 通过；独立 native provider 和原始长度 namespace 均能读写，此初始化故障的具体原因未证实。

审查补齐重设成功但本机删除失败的恢复闭环：匹配旧 token 的内存权限立即撤销；只有专属续期入口遇到精确本地已撤权 owner 才返回 login_required，显式登录随后重试保护存储清理。清理仍失败时保持 typed failure，不重放重设码，也不把未知 scope mismatch 当作登出。

## Go 实现与独立验证补充

- 新增 shell-only `user.renew`、`user.resetPassword`；MethodTableVersion 保持 2，现有操作形状不变。HTTPS owner 只使用已配置服务的 `/v1/session/renew`、`/v1/password/reset`，不重试其他接口。
- 续期以 exact token、canonical record、revocation owner 和生命周期约束写入/readback。专属 renewal scope 允许向服务器核实失去回复后陈旧的本地期限；普通 selected-session scope 仍拒绝本地到期，且不能借用 renewal context。真正过期或已撤销的服务端会话不复活。
- 重设前只有新鲜 CurrentUser 的真实 email 匹配才能撤销本地选中会话。未知、其他账号和本地已到期记录不因恢复其他账号而被清理。HTTP 时换 token/期限、实际 logout admission、持久写失败、持久删除失败均有 targeted regression；删除失败也保留本地 revoked fence。
- `go test ./internal/helper ./internal/controlplane ./internal/localrpc ./internal/core -count=1` 全部通过，helper 113.23s、controlplane 15.31s；focused `-race` 验证通过，最新 helper 10.44s。`go vet ./internal/helper ./internal/controlplane ./internal/localrpc` 通过。新增/修改 Go 源码均小于等于 1000 行，最大 host.go 994 行；`git diff --check -- networking` 通过。
- 独立 production server binary、production Core/Helper dispatch 和真实 macOS Keychain 的 `TestAccountSessionRecoveryRealCoordinatorAndNativeStore` 通过；加 `-race -tags native_secrets` 的独立运行也通过（11.61s），原始输出保存在 ignored `.run/account-session-recovery/live-integration.log`。测试使用随机 regression namespace，未打开已安装应用的账号凭据。覆盖30天登录、同 token 续期、保存读回、provider/Host 重开、陈旧本地期限恢复、管理员 CLI 发码、重设、旧 token/密码拒绝、十二个中文字符新密码、原 user/network/device/pair 与证书/公钥保留、code 不可复用。
- `go test -tags native_secrets ./internal/secret -run '^TestKeychainProfileNamespaces$' -count=1 -v` 真实平台隔离专项通过（71.46s）。源码 UI 启动曾观察到的 `p2p.secret_write_failed` 没有在上述独立真实原生路径复现；不能据此宣称该 UI 启动故障已解决。
- 独立审阅服务端 reset/renew 事务、密码哈希约束的迟到 login、HTTP admission/迁移，以及 Electron 自动续期和迟到回复保护，未发现阻断问题。Go scope 实现由 root 另行审查，此条不构成作者自审验收。没有把 macOS 证据扩展为 Windows 或生产部署验收。

### 明确撤权后的清理重试

确认 reset 成功但 native 删除失败后，原 owner 已明确撤权。只在新的 user.renew 入场、exact canonical token/record 匹配该 revoked owner 时返回 user_login_required，允许显式清理重试；一般 scope 失配、HTTP 中途注销及传输失败不改类。存储删除持续失败仍必须报告原错误，不重放 reset code，不复活原 token；清理恢复后须通过新密码的真实认证。新增 helper regression 覆盖删除失败、错误 token 不能借用撤权、精确旧 token 不再发 HTTP、清理持续失败、provider 恢复后清理及同账号新 session 登录。

该补丁的 focused helper `-race` 验证通过（9.58s），OpenSpec strict validation 与 diff-check 通过；host.go 仍为 994 行。没有为该补丁重新运行完整测试或真实账号恢复。

### 隔离 source app 原生初始化诊断

停止的 source app 日志只能证明既有 device.createKey/machineDeviceKey 的 Store.Set 失败；该旧分支把底层 provider 错误改写成 secret_write_failed，未保留 security 的原始退出原因。本次未修改该分支或 secret provider。仅查询该隔离 profile 的 Keychain metadata，machine.device-key header 和首 chunk 均不存在；未读出 secret 值。

使用同一个 build/p2p/darwin-arm64/dshkerd，在全新随机 namespace 下通过 core.secret_set/get/delete；再以与 app 相同长度的 profile-64hex namespace、machine.device-key 和 64 字节诊断 payload 写入/readback/删除也全部成功。仅新建的诊断进程退出 0，隔离 key 已清理，未重启正式或原 source app。原始进程日志在 ignored `.run/account-session-recovery/native-diagnostic/core-short-state.log` 与 `core-profile-namespace.log`。首次诊断因 Unix socket 路径过长报 helper_listen_failed，使用显式短临时 state 后通过，此次启动失败不归类为 provider 失败。现有证据未证明 source app 的单次失败由本次续期/重设变更引起，也不足以断言其具体环境原因已查明。

## 独立桌面审查与表单验证

桌面审查发现并回归关闭两项问题：未知异常原文可能含恢复码或密码，IPC 现在仅记录固定错误码；并发续期替换内存对象后，成功重设现在按原 token、userId 和邮箱清除已撤销会话，不再依赖旧对象相等。额外提出 Go 本地过期期限不能挡住服务端仍授权的续期核对；该路径由独立的 renewal scope 实现，普通授权 scope 仍拒绝过期权限。

表单、领域和既有账户回归运行通过 8 个文件 / 107 项测试。后续 IPC、主进程续期及完整重设面板运行通过 3 个文件 / 123 项测试；两组有重复测试，不合并计数。`npm run type-check` 通过。所审桌面源码和新增测试已逐文件检查 1000 行上限，无超限。

重设 UI 的确认、64 位小写十六进制恢复码、12 个 Unicode 字符和 72 个 UTF-8 字节边界、提交前清空 secret、切换/销毁清空、拒绝输入、生命周期/会话修订变化、未确认结果不重提，以及手动使用新密码登录均有组件/领域回归。组件测试的 bridge 适配器只存在于测试文件；它们不替代独立协调器与原生凭据存储的真实集成证据。

`test-gates/account-session-recovery.json` 最终覆盖 20 个生产源码文件，并绑定具体来源、身份键、状态矩阵和测试断言；static 模式通过。互动契约只声明 diagnostic：目前没有原始 frame/timing ledger，不能据此通过 default verify 或宣称发布验收。最后 default verify 中真实服务端与原生存储集成通过（9.483s），随后因缺互动 ledger 明确失败；不能用 static 结果替代。

服务端 131 个顶层 race 测试三组完整覆盖通过，保留原默认 timeout，实际 pass 集合无缺失、无重复。独立服务端模块的默认 integrity、vet、Linux 双架构和 macOS 构建通过；Go workspace 全局历史治理违规仍非零，单进程全量 race 的默认10分钟超时保留为失败证据，没有把分组完整覆盖伪报成原单进程命令通过。桌面最后清理闭环的五文件170项、Unicode注册验证三文件80项分别通过，重复用例不相加。独立复审未发现最终清理恢复路径的阻断问题。

安全存储错误后续：新增 provider/read/write/delete 四种 typed refusal 的 IPC 白名单与中英文可操作提示；`secret_missing` 仍仅由 native-secret adapter 表示真实缺失。密码重设后的删除失败明确保留未确认状态、禁止再次提交恢复码，允许手动新密码登录核对。对应 IPC、字典、面板和共享词表运行通过 5 个文件 / 139 项测试，包含既有回归；未把它计为原生存储/UI smoke 成功。
