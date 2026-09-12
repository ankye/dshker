# 2026-09-11 P2P 客户端对齐"网络共同成员"连接授权

## 背景与探测

用户部署的协调服务器在 my.ffkey.com:8443(内置预设
`P2P_BUILTIN_SERVICE`),开放注册且是邮箱时代(register 直接建号、错误
码 `p2p.invalid_user_credentials`/`p2p.login_failed` 等一致)。

往本地服务器仓库 HEAD(7f1b706,已含 4eaa298 "pair devices that already
share a network")重建 server 二进制后,集成套件出现 `p2p.pair_unauthorized`
簇——客户端仍是旧模型(attempt 传 pair 记录 ID,`start()` 断言
`lease.PairID == pin.Pair.PairID`),而新 server 的 BEGIN 把 /v1/attempt
的 pairId 参数当作**目标设备 ID**,授权条件只剩同一网络 + 双方 presence
在线,不再需要任何 pair 记录。

**决定性探针**:写临时 Go 程序(controlplane.Client,已删除)对部署实例
直接操作——注册两个设备进同一网络、无任何配对记录、双方 WSS 在线后
`Begin(targetDeviceID)` → **`BEGIN_CO_MEMBERSHIP_OK`**,续租/结束均通。
证明部署服务器已是共同成员制,客户端必须对齐才能链接。

## 客户端改动(全部在 apps/dsh-launcher/networking)

- `internal/peersession/manager.go`(生产路径,helper/dshker-peer 共用):
  - `Connect`:先从 `pins[pairID]`(pair 记录)解析**远端设备 ID**,再
    `Begin(target.DeviceID)`;会话按 pair 记录 ID 键控。
  - `start(pairID, lease, reserved)`:pin 按记录 ID 反查;出站校验
    `remote == lease.ToDeviceID`、入站校验 `remote == lease.FromDeviceID`;
    `TransportOptions.Revision` 改用 `lease.Revision`(共同成员制租约
    revision 恒 1,与 pair 记录修订解耦,签名验签必须用租约值)。
  - `receive()`:入站 attempt 按「远端设备 ID + 网络」反查确认过的 pair
    (`pairForRemoteLocked`);signal 改按 **attemptId** 路由
    (`sessionByAttemptLocked`),因为 signal.PairID 现在等于目标设备 ID
    而非记录 ID;`revoked` 事件仍携带 pair 记录 ID,行为不变。
  - `run()`:对外 `State.PairID` 回填**记录 ID**(session 新增 `PairID`
    字段),app 的 `state.pairId` 契约不变。
  - `end(lease)` 传 `lease.PairID` + attemptId,与 server /v1/end 语义一致,
    无需改动。
- `integration/process_child_test.go`(测试驱动,镜像同一模型):
  - `connect` 命令 `Begin(remote.DeviceID)`;`start()` 校验
    `lease.PairID != remote && lease.FromDeviceID != remote` 时拒绝
    (出站 lease 点名 target、入站点名本机,From 才是对端);
    `Revision: lease.Revision`。
  - `revoked` 事件按 `config.Pin.Pair.PairID` 比对(pair 记录 ID),置本地
    `revoked` 标志——server 不再查 pair 记录,吊销必须由客户端本地拒绝
    (manager 侧靠删 pin 实现同一语义)。
- `.run/p2p-stability/go-test.jsonl`(证据):`-race ./... -count=1` 全绿
  **162 pass / 0 fail**(上一轮 150 pass / 12 fail)。

## 语义目前的样子(对照旧模型)

| 项                                                                 | 旧(客户端)               | 新(部署 server + 客户端)        |
| ------------------------------------------------------------------ | ------------------------ | ------------------------------- |
| /v1/attempt 的 pairId                                              | pair 记录 ID             | 目标设备 ID                     |
| 授权条件                                                           | 有效且未撤销的 pair 记录 | 同一网络共同成员 + 双方在线     |
| lease.PairID                                                       | pair 记录 ID             | 目标设备 ID                     |
| 租约 revision                                                      | = pair 记录修订          | 恒 1,Begin 新发                 |
| signal.PairID                                                      | pair 记录 ID             | 目标设备 ID                     |
| revoked 事件 payload                                               | pair 记录 ID             | pair 记录 ID(不变)              |
| 远端公钥来源                                                       | pair identity pin        | 仍是 pair identity pin(网络设备 |
| 视图不携带证书/公钥;pin 是唯一信任锚,所以客户端保留 pair 记录门禁) |

## 下一步(进行中)

- 双端实跑:macOS 已全绿;Windows 需重建 dshkerd.exe(含 core.secret\_\*)
  与 dshker-peer.exe(新共同成员制代码)再跑集成/管理测试并留证。
- 实连 my.ffkey.com:mac/win 各注册/登录 → 建网 → 入网 → pair 确认 →
  peer.connect,期望真实 UDP 直连与远端 DSH 执行,再经 ssh -L 反代访问
  Windows 的 DSH Web。3.5/1.4(TS 半边、renderer 冻结断言)依新优先级
  置后。
