# P2P 实施进度

## Scope and ownership

- 用户授权：优化审查方案后实施；所属变更 `add-self-hosted-p2p-dsh-connections`。
- desktop track；本仓库只拥有 `networking/` peer/协议与 Electron 集成。按用户最新要求，服务器移至独立 `ankye/dshker-server`，不依赖 NetHopper、OneIsland、NATS。ZeroTier 仅参考，不修改。
- 无 TURN、SSH 自动切换、默认服务或伪造成功；未提供部署目标，不做外部部署/发布。

## Review decisions

- 业务流关闭与控制面/数据面故障分离；共享 helper 崩溃影响全部 P2P，Local/SSH 不受影响。
- 显式备份恢复创建新服务身份并作废旧授权，防止旧备份使撤销复活。
- 30 天设备证书、7 天续期窗口，同密钥/身份续期不改变配对；过期恢复需新管理员单次凭证。
- 增加由目标设备分享的单次配对码；未知目标仅从此命名准入入口加入。
- 增加显式忘记失联服务器，本地 tombstone 先于清理，不冒充服务器已撤销。
- 测试提示可能启动并保留远端 DSH，测试只清理连接；并发受管启动合并。

## Evidence

实施进行中。规格/用例更新不是运行证明，真实部署、跨机器与四架构制品验收仍未执行。

## 独立服务器调整后的本地验证

- 服务器源文件及原型 CLI 已从本仓库移除，客户端模块不再依赖 SQLite/coordinator。协议副本的用户/网络租约签名字节保持一致。
- SSH 编辑已贯通 catalog/update IPC/preload/domain/表单/固定标签；本地 focused 42 项通过，不代表完整 P2P UI 已完成。
- `npm run environment:check`、`format:check`、`architecture:check`、`type-check`、`service:smoke`、`visual:smoke`、`build`、`build:electron` 及 desktop-app validator 通过。visual:smoke 是规则检查，不是原生交互验收。
- 全量 Vitest 初跑 506/509；未修改的 pnpm-launcher 测试期望非规范临时路径。明确使用 macOS 实际 `/private/var` 临时根复跑后 92 文件、509/509 通过，未修改生产 pnpm 行为或削弱断言。
- 客户端 `go test -race ./...` 与 `go vet ./...` 通过；Pion 在本机真实 UDP/DTLS 通信，不是跨物理机证明。
- 服务器由自己的 `add-dshker-user-networks` 变更跟踪，完整 race/vet、独立依赖检查及实际二进制 HTTPS/绑定/删除/登出冒烟通过。
- 待完成：用户/网络/P2P 界面、helper supervision 与真实 DSH HTTP/WS adapter、交互 gate 原始 ledger、四架构 packaged smoke、公网与跨物理机验收。未部署、未推送、未发布，也未归档。
