# P2P 连接状态改造交接

面向接手界面工作的同学。数据层已完成并通过全部门禁；界面消费方式与约束见下。

## 一、核心概念：两层，别混用

远程连接有两层，它们回答不同的问题。之前代码没有区分，导致同一台电脑在两个页面显示相反的状态。

| 层           | 决定什么                           | 数据源           |
| ------------ | ---------------------------------- | ---------------- |
| **网络会话** | 本机是否在线、能否被发现、能否配对 | `p2pNetwork`     |
| **配对连接** | 某台远程电脑此刻能否打开           | `p2pConnections` |

**不要用配对连接回答网络问题。** 原来「我的网络」用 `stage === 'ready'` 判断在线，而 ready 需要有配对对象，所以单机用户永远显示离线 —— 那个阶段结构性不可达。

## 二、网络会话（第一层）

```ts
import { p2pNetwork } from '@/app/domains/remote-connections'

p2pNetwork.isOnline(serviceId) // true | false | undefined
p2pNetwork.refusal(serviceId) // 错误码，在线或未读时为 ''
```

`undefined` 表示**尚未读取**,不是离线。必须与 `false` 分开显示，否则会在读取完成前误报离线。

已接入两处：

- 「我的网络」卡片 —— `P2PJoinPanel.vue`,离线时显示 `refusal` 错误码
- **全局状态栏** —— `ShellStatusbar.vue`,每个路由都可见

状态栏 props：`networkLabel` / `networkValue` / `networkState`('online' | 'offline' | 'unknown')。

### 生命周期（不需要你操心）

`AppShell` 挂载时调用 `p2pNetwork.start()`,它做三件事：订阅推送、开通内置服务、读取会话。之后：

- 主进程状态**变化时推送**,渲染层自动重读
- 每 60 秒扫描重试不在线的服务（已在线的不动）
- 运行时失效会把会话标为离线，附 `p2p.helper_unavailable`

**不要在页面里自己加轮询。**

## 三、配对连接（第二层）

```ts
type RuntimeTabStatus =
  | { kind: 'disconnected' }
  | { kind: 'connecting' }
  | { kind: 'ready' }
  | { kind: 'failed'; code: string }
```

`tab.status` 现在两种来源对等（SSH 与 P2P),`undefined` 同样表示未读取。

`code` 是**错误码不是文案**,需要自己映射到 i18n。

样式钩子 `.browser-tab[data-state='...']` 四种状态都已存在，`RuntimeTabsPanel.vue` 已在用 `tab.status?.kind`。

## 四、硬约束

**P2P tab 的 `status` 里绝不能含地址。** DSH 入口留在主进程，由主进程直接交给 guest。这是为什么没有复用 `RemoteConnectionStatus`(它的 `ready` 带 `url`)。SSH 侧也经 `withoutAddress()` 投影，两边同形。

已有测试断言 ready 状态不含地址。改动这块时别绕过它。

**吊销的配对报 `disconnected`,不报 `failed`。** 失去授权不是连接故障。

## 五、i18n

新增键（zh-CN / en-US 均已齐备）：

- `p2p.myNetwork.statusUnknown` — 状态未知
- `p2p.myNetwork.offlineReason` — 未能上线：
- `footer.network` — 网络

`failed` 的 `code` 尚无对应文案映射，如果界面要展示配对连接的失败原因，需要新增。

## 六、测试

1187 项通过。相关文件：

- `src/app/domains/remote-connections/p2pNetwork.test.ts` — 网络层（新增）
- `src/app/shell/tests/peerRuntimeTabs.test.ts` — tab 状态投影
- `src/app/shell/tests/ShellStatusbar.test.ts` — 全局可见性
- `electron/main/p2p/management.test.ts` — 会话保留、失效、周期重试

两个关键用例，改动时容易碰到：

- 单机零配对且会话在线 → 必须显示在线（这是最初的 bug）
- 有配对但未连接 → 仍显示离线（严格定义未被削弱）

## 七、未完成

- `failed` 错误码 → i18n 文案的映射
- 配对连接状态目前只在 tab 指示器上用；如果别处也要显示，读同一个 `p2pConnections`,不要新开算法
- 状态栏只显示当前选中服务的会话；多服务场景未设计

## 八、今天的提交

```
b97d62c feat(p2p): report pair connection state on a paired computer's tab
d8609c4 fix(p2p): maintain the coordinator session instead of attempting it once
cf7ec8b fix(p2p): fill network status at shell start, not on first visit
1b20a9c feat(p2p): make network reach a shared fact instead of a per-surface guess
0596f53 Revert "fix(p2p): stop reporting an unpaired computer as offline"
634fec6 fix(p2p): load remote connection data on entry instead of demanding clicks
eaeeee3 fix(ui): restore product-grade hierarchy on remote connection surfaces
```

`0596f53` 撤销了 `1d3bc04`:那次改动在配对连接层给单机加了「尚无配对设备」状态，属于在错误的层打补丁。真正的问题是位置用错了数据源，已由 `1b20a9c` 修正。
