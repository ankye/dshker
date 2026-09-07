# 远程工作台 DSH 接口审计（2026-09-07）

状态：源码审计、传输模块诊断，以及隔离的真实 DSH 客户端导航读回，不是完整工作台验收。OpenSpec 1.4 保持未完成：正式远程组合、支持版本约束和完整交互验收尚未闭环。

## 实际版本

- 本机 Launcher 的 `harness-current.json` 明确选择提交 `a66e4702047846cdaa10c66c9d3df3951f5ea70d`，对应版本目录的 Git HEAD 已核对一致。
- 参考开发仓库 `/Users/a1021500932/work/deepseek-harness` HEAD 为 `76fda729799fe9b3848dbe2c211d4b231032b81e`，不等于选定运行版本。未修改两个 Harness checkout，也未改变当前版本指针。
- 下列协议在实际选定版本源码核对；不能据此宣称任意 master 或旧版本兼容。

## 已核实能力与限制

路径均相对于对应 Harness checkout。

| 能力         | 源码与真实契约                                                                                                                                                                                                     | Launcher 约束                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 一次性调用   | `packages/client/connection/src/rpc-host.ts`：POST `/api/<namespace>/<method>`，JSON `client-request`，`rpcId`、`method` 与路径一致；`packages/api/gateway/src/index.ts`：payload 必须是 `{ args: { …命名参数 } }` | 不能把生成的 Remote 当作随意 REST API；错误 envelope 与 HTTP 状态分别检查                              |
| 业务持续流   | `packages/api/gateway/src/stream-protocol.ts`：WebSocket `/api/remote.mux`；`gateway/src/index.ts`：Upgrade 先走 Connection 认证                                                                                   | 按真实 WebSocket 协议传输；不可用轮询伪装工作流恢复                                                    |
| 目录         | `packages/api/workspace-controller/src/directory-picker.ts`：`directoryPicker.pick/list/createDirectory`；backend native/browse 互斥                                                                               | `pick` 弹的是 Host 原生窗口，不是访问方窗口；未传 list 路径的 Home 语义不能作为 Launcher 授权根        |
| 选择器组合   | `packages/host/directory-picker-auto/src/resolve.ts`：macOS/Windows loopback、非 SSH 启动时选择 native                                                                                                             | P2P 不会自动产生 SSH 环境变量，不能声称原生按钮已经适合远程；不得伪造 SSH 环境                         |
| 注册工程     | `packages/api/workspace-controller/src/index.ts`、`commands.ts`、`types.ts`：`workspace.create(request: {path})` 返回 `{workspace,created}`；`workspace.follow` 读回 baseline/增量                                 | 路径须来自当前获准引用；按 canonical path 幂等解析，但 UI 是否已选中要另行核验                         |
| 建立会话     | `packages/api/session-controller/src/commands.ts`：`session.create` 支持明确 `sessionId`、`workspaceId`，不能同时指定 cwd 与 workspaceId                                                                           | 显式保存原请求身份，拒绝默认 cwd；会话创建与 workspace attach 存在部分成功错误，不能盲重试             |
| 切换网页会话 | `packages/client/ui-workspace/src/client/navigation.ts` 与 `packages/api/session-controller/src/client/sessions/service.ts`：网页内部 `sessions.open(sessionId)`                                                   | 服务端创建成功不等于指定 guest 已切换；当前检查没有发现受支持的外部定向导航入口                        |
| 系统打开路径 | `session.openWorkspacePath` 调 Host 的系统 opener                                                                                                                                                                  | 不是“在 DSH 中选中工程”，不可误用为工程打开接口                                                        |
| 任务恢复     | `session.page/follow/control`；`session.prompt` 带 requestId；`session.cancel` 显式取消。`client/sessions/manager.ts` 的重新连接刷新 baseline                                                                      | 断网不是任务停止；按原 session/request/job 和 runtime generation 读取，不重放 prompt；没有记录只能未知 |

调用示意仅用于协议说明，不含凭据，不是新增公共 API：

```json
{
  "type": "client-request",
  "rpcId": "caller-owned-request-id",
  "method": "workspace/create",
  "payload": { "args": { "request": { "path": "explicit-authorized-remote-path" } } }
}
```

## 已批准的客户端扩展契约

完整“Launcher 选工程 → 对应 DSH guest 进入指定会话 → 精确读回”需要受支持的、限定该客户端的导航与结果确认接口。不能直接执行网页脚本、写内部 store 或伪造 localStorage；也不能广播切换其他本地/远程客户端。

用户已批准补齐扩展。实现归 Launcher 的 `packages/dshker-workbench-client` 所有，不修改 Harness 源码：验证来源和目标客户端，接收明确 session identity，等待列表确认后通过公开 `sessions.open` 操作，返回当前选择的实际身份。请求、取消和读回通过隔离 preload 的固定命名通道传递；主进程绑定 computer/attempt/runtime generation/origin/main frame。正式远程目录选择界面、运行注册和受管安装仍需接通。

## 真实客户端加载诊断

`tests/runtime/run-workbench-diagnostic.mjs` 使用显式选定的已构建 Harness、临时 DSH_HOME/工程/Electron userData，启动真实 DSH CLI（动态端口）和原生 Electron。通过实际 RPC 创建工程、会话，再由生产 `WorkbenchGuests` 对实际页面扩展发送命名导航并验证读回。不执行任意网页脚本，不发送模型请求。

诊断发现两个真实安装/构建问题并修正：客户端声明需要标准 `dsh.bundle.patch` 才会进入 profile；客户端输出必须是 DSH 模块注册 factory，而不是普通 ESM。构建新增实际生成物注册/导出检查，防止只通过源码检查却破坏浏览器批量脚本加载。认证按实际协议验证根路径 token 交换的 HTTP 303 与 Cookie，日志不输出 token。

首次真实导航、路径/会话读回已成功；截图仍有 DSH 首次内测声明遮罩，因此该截图不是可交互页面验收。隔离测试组合不等于正式 Launcher 两端 P2P、工程选择 UI、Windows 或发布完成。

## 本轮新增生产传输模块

`networking/internal/peer/streams.go`、`stream.go` 和 `internal/protocol/window.go` 实现可靠有序 DataChannel 上的 OPEN/DATA/WINDOW_UPDATE/FIN/RESET 复用。每方向窗口 128 KiB，最多 64 活跃流，接收固定环形缓冲合计不超过 8 MiB；发送无额外无界应用队列。消费者实际读取后才归还 credit。

发起方使用递增奇数 streamId，对方使用递增偶数，代次内不复用。未分配的 id、重复 OPEN、错误 attempt/runtime generation 和 credit 膨胀拒绝；已退休 id 的在途帧只丢弃，不恢复资源。FIN 保留未读数据和反向通道；RESET 清理本流，不关闭其他流。

新增测试经真实 Pion UDP/DTLS/DataChannel 验证，但仍沿用测试专用签发身份/STUN 端点。它们不是独立协调服务器全链路、Electron helper、DSH HTTP/WS、真实 UI、Windows 或一小时稳定性验收。不得将这些结果作为发布通过证据。
