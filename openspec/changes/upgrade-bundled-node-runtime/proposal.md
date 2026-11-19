## Why

2026-11-20 在 `~/.dshlauncher/logs/dsh-web.log` 中看到：

```
[WARN] Unsupported engine: wanted: {"node":">=24.9.0"} (current: {"node":"v22.23.3","pnpm":"11.28.5"})
```

受管 DSH 0.2.2-rc.5 的根 `package.json` 声明 `engines.node >= 24.9.0`，而 Launcher
内置 runtime 仍是 Node 22.23.3。DSH Web 当前仍能启动，但每次都在"不受支持的引擎"
警告下运行，更新的 DSH 版本可能直接拒绝启动。本机系统 Node 虽已是 24.x，但按既有
规格，内置 runtime 缺失或无效时必须明确拒绝、不得回退系统工具，因此唯一正确的修复
是升级内置 Node 本身。

## What Changes

- `tools/prepare-runtime.mjs` 的 `NODE_VERSION` 从 22.23.3 升到 24.22.3
  （v24.x 官方当前最新，2026-11-11 发布）；六个平台归档与独立
  `node-v24.22.3-headers.tar.gz` 的 SHA-256 全部替换为 nodejs.org 官方
  SHASUMS256.txt 中的对应值。
- `electron/main/pnpm-launcher.ts` 的描述符校验 pin 同步升到 24.22.3。旧的
  22.23.3 stage 会被判无效并要求重新 `runtime:prepare`，与"不推断、不替代"的
  失败规则一致。
- `tools/release-smoke.mjs`、`electron/main/pnpm-launcher.test.ts`、
  `tools/prepare-runtime.test.mjs`、`tools/release-smoke.test.mjs`、
  `tools/test/node-headers-archive-check.mjs` 同步新 pin。
- README、README.zh-CN、docs/architecture.md、docs/release.md 与
  `openspec/changes/bundle-pnpm-runtime` 的 spec 文本同步为 24.22.3。

不改动 pnpm pin、stage 目录布局、描述符 schema 4、启动方式或 IPC 契约；也不引入
"自动选择最新 Node"的行为——版本身份仍是打包门禁的一部分，必须手工 pin。

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `bundled-pnpm-runtime`: 暂存的官方 Node 从 22.23.3 升为 24.22.3，归档校验和换为
  官方新值；其余要求（完整性校验、拒绝回退系统工具、headers 归档、烟测）不变。

## Impact

- `tools/prepare-runtime.mjs`、`electron/main/pnpm-launcher.ts`：版本与校验和 pin。
- 五个测试/工具文件同步期望值；四个文档与既有 spec 文本同步。
- 用户可见变化：安装包内置 Node 变为 24.22.3，DSH 启动不再出现引擎警告；已安装的
  旧版本升级后内置 runtime 随安装包整体替换，无迁移路径。
