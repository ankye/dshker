# 本地双进程稳定性/压力/断连验证

## 范围与身份

- 用户要求先本地测试，Windows 后续由用户在发布后验证；本轮不发布。
- 归属 `add-self-hosted-p2p-dsh-connections`，服务器协议补齐由独立 `dshker-server` / `add-dshker-user-networks` 所有。
- macOS arm64，真实服务器二进制 + 两个独立 Go 测试进程，调用生产 controlplane/peer/protocol。最终连通用例 PID：server 45749，A 45750，B 45753；两个不同设备身份。无服务器业务中继。
- 客户端新增严格 HTTPS/mTLS、服务身份/nonce/pin 校验、账户/网络/登记/配对 API、WSS 信令与心跳。服务端补充仅配对参与者可读的公开身份接口，未将服务器代码耦合到客户端。
- `_test.go` 驱动不进入生产包；初始化秘密只经 stdin 私有管道，在进程内存使用；本地测试证书不加入系统信任。未接入 Electron helper、主进程安全存储或真实 DSH adapter。

## 最终复跑证据

2026-09-07 14:29:22–14:32:05 +08:00：

```bash
cd networking
DSHKER_SERVER_BINARY=/Users/a1021500932/workspace/go_workspace/dshker-server/bin/dshker-server go test -race ./... -count=1 -timeout=6m -json
go vet ./...
```

四个包通过，integration 162.995 秒。原始日志：`networking/.run/p2p-stability/go-test.jsonl`；不提交生成证据。

| 项目       | 实测结果                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------- |
| 基础连接   | 两端非 relay UDP/DTLS，双向 SHA256；约 233 ms                                                  |
| 压力       | 双向共 134217728 字节 / 8192 包；顺序和 SHA256 完整；4.786 秒                                  |
| 重连       | 30 次显式断开/新 generation 重连；4.730 秒                                                     |
| 资源观测   | A goroutine 44→44，heap 1321752→2732784；B 42→42，heap 1540144→2138120 字节                    |
| 短时稳定性 | 90 秒，89 轮双向探测，WSS 持续在线并按真实 20 秒续租                                           |
| 服务强杀   | 有效租约内继续双向通信；约 49.457 秒后在签名到期范围内关闭；重启不恢复旧在线状态，重新连接成功 |
| peer 强杀  | 约 6.116 秒识别失败，旧连接拒绝发送，新进程可显式重连                                          |
| 撤销       | 约 4.113 ms 两端收到撤销并关闭，继续发送/重连拒绝                                              |
| 慢读/超限  | 接收停止读取后有限队列以 `p2p.receive_limit` 关闭；64 KiB + 1 发送被拒绝                       |

## 门禁与限制

- 新控制面负向测试覆盖缺字段/重复字段、无效端点、TLS 不信任、跨 origin 重定向、错误 nonce/pin、证书公钥/设备不一致、跨用户/第三方配对读回。没有跳过集成测试：缺显式服务器制品即失败。
- 独立服务器 full race、vet、依赖边界、真实制品 HTTPS/持久化 smoke 与默认 test-integrity verify 全部通过：11 测试文件、3 命令、1 证据。
- App OpenSpec 和 server OpenSpec strict 校验通过。
- App 的 `test-gates/p2p-local-transport.json` 默认 verify **失败**：完整工作树还有此前的 Electron/SSH 编辑/UI/日志改动未由该 Go-only 清单声明。没有缩小 Git 差异、弱化门禁或将其宣称为整体验收通过。
- 90 秒不是小时级 soak，短程资源回归不是长期无泄漏证明。本机进程不是两台物理机；尚未覆盖多 peer、单向断网/网卡/休眠、NAT、Windows、四架构安装包。
- 慢读关闭仅是有限队列防护；stream credit/半关闭/64 streams/8 MiB 排队及 DSH HTTP/WS 仍未实现。远程 UI/helper/动态端口/固定标签的真实 DSH 联调仍未完成。保持相关 OpenSpec 任务未完成，不归档、不提交、不推送、不发布。

复现步骤及完整范围见 `docs/testing/p2p-local-stability.md`。
