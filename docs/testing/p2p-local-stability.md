# 本地 P2P 稳定性验证

## 范围

本机 macOS arm64，1 个真实独立 `dshker-server` 二进制，2 个不同 PID、不同 Ed25519 设备身份的 Go 测试进程。客户端使用生产 `internal/controlplane`、`internal/peer` 和 `internal/protocol`；真实 HTTPS/mTLS、WSS、STUN、UDP ICE、DTLS/SCTP，不经服务器转发业务字节。

进程驱动只在 `_test.go` 中：通过 stdin 私有管道初始化，凭据不进入 argv 或输出，临时证书只加入测试客户端的信任池，不修改系统信任，不使用跳过 TLS 校验。临时数据库和密钥由测试清理。

这不是两个完整 Electron App：生产 helper 启动/监督、安全持久化、DSH HTTP/WebSocket adapter 与远程 UI 尚未接通。本机直连也不能证明跨 NAT 或 Windows 可用。

## 复现

先在独立服务仓库构建，保留当前 Go workspace；`-mod=readonly` 仅处理当前工作区 vendor 不匹配，不改变服务依赖边界：

```bash
cd /Users/a1021500932/workspace/go_workspace/dshker-server
go build -mod=readonly -trimpath -o bin/dshker-server ./cmd/dshker-server
go test -mod=readonly -race ./...
go vet -mod=readonly ./...
go run -mod=readonly ./tools/check-boundaries
```

再从客户端模块执行；服务器路径必须指向上一步真实制品，缺失时测试失败，不跳过：

```bash
cd /Users/a1021500932/workspace/desktop_workspace/apps/dsh-launcher/networking
export DSHKER_SERVER_BINARY=/Users/a1021500932/workspace/go_workspace/dshker-server/bin/dshker-server
mkdir -p .run/p2p-stability
set -o pipefail
go test -race ./... -count=1 -timeout=6m -json | tee .run/p2p-stability/go-test.jsonl
go vet ./...
```

## 用例与硬断言

| 测试                                        | 验证                                                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `TestTwoPeerProcessConnectivity`            | 独立进程与设备、真实非 relay UDP 候选对、双向 SHA256 一致                                                                     |
| `TestTwoPeerProcessLoadAndReconnect`        | 双向各 64 MiB，合计 8192 包；逐批内容/顺序哈希；64 KiB + 1 拒绝；30 次显式新 generation 重连；goroutine/heap 观测预算         |
| `TestTwoPeerProcessSoakAndServerLoss`       | 90 秒双向探测、WSS 持续在线、真实 20 秒续租；杀服务后有效租约内继续传输、到期关闭；原身份重启后 presence 不复活，显式重连成功 |
| `TestTwoPeerProcessAbruptLossAndRevocation` | 杀 B 后 A 在 10 秒内失败；新 B 进程重连；撤销后 3 秒内两端终止且新连接拒绝                                                    |
| `TestTwoPeerProcessSlowReceiverIsBounded`   | 接收者停止读取，超过 64 消息有限队列后 `p2p.receive_limit`，不无限增长、不假报成功                                            |

30 次重连后的资源预算为基线 + 12 goroutine、heap + 64 MiB；仅用于本轮短程退化检测，不等于长期无泄漏证明。90 秒是短时稳定性测试，不是小时级 soak。

慢接收端目前会使整条 transport 失败，这是有限队列防护通过，**不是** DSH stream credit/backpressure 已完成。后续必须实现并验证 OPEN/DATA/FIN/RESET/WINDOW_UPDATE、64 streams、8 MiB 总排队、半关闭与真实 HTTP/WS。

## 发布前仍需补齐

Electron helper 与 OS 凭据存储、真实 DSH 会话/动态端口/按需标签/状态交互、单向断网/网卡变化/休眠、小时级 soak、多 peer 并发、Windows 与四架构安装包、跨物理机与 NAT 矩阵。当前测试不授权发布，也不代表这些关卡通过。
