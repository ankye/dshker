## Context

`readHarnessReadiness` 是状态页、插件操作与版本准备共用的单一就绪判定。它原本只证明"文件在"：`package.json`、`apps/cli/lib/bin.js`、`.git`。2026-11-15 的 Windows 事故证明这不够：pnpm 的 workspace 链接层被破坏后，所有文件仍在，子进程启动即 `ERR_MODULE_NOT_FOUND`，而判定仍报就绪，导致损坏版本被反复复用（切换复用、应用重装也复用）。

## Decisions

### 检查依赖解析，而不是新增文件清单

`assertDirectRegularFile` 拒绝任何符号链接组件，因此不能用于 `node_modules` 路径。新增 `assertResolvableRegularFile` 用 `stat` 跟随链接并要求普通文件：pnpm 的 junction/symlink 层一旦不可解析（Windows 上表现为 `UNKNOWN`），`stat` 直接失败。

必需项：

- `node_modules/tsx/package.json`：Web 子进程通过 `pnpm dsh` 运行 `node --import tsx/esm apps/cli/src/bin.ts`，这也是 `worktree-preparer.ts` 的 `assertSourceLauncher` 已经假设的前提；
- 内置入口 `apps/cli/lib/bin.js` 中出现的 `@deepseek-ai/*` 包，最多两个：从入口实际 import 推导，避免把具体包名写死，也让"构建把依赖内联掉"的版本自然退化为只检查 `tsx`。用 `stat` 在 `apps/cli/node_modules/<name>/package.json` 上验证。

### 失败原因与恢复路径分离

依赖层失败返回独立消息 `has an unresolvable dependency tree`，与"缺少内置 checkout"区分。恢复仍走既有路径：非活动版本由 `removeInterruptedVersion` 删除重建；活动版本继续拒绝原地准备（正在使用中的目录不能被删除），提示先切换版本。

### 成本

每次就绪读取多一次 `bin.js` 读取（数十 KB）与 1–3 次 `stat`；没有遍历 `node_modules`，所以轮询状态不受影响。

## Non-Goals

- 不为活动版本自动重建或新增"修复"按钮：删除正在使用的版本目录风险高于收益，显式切换版本已能恢复。
- 不校验完整依赖闭包：那等于重新实现包管理器；只证明链接层可用与入口声明的依赖可解析。
- 不改变 overlay、启动命令、profile 或版本目录布局。

## Risks

- 若未来 Harness 版本把 `@deepseek-ai/*` 依赖内联或改名，入口推导会自然跟随；若 `scripts.dsh` 不再使用 `tsx`，`tsx` 检查会成为误判，需要随该事实更新（`worktree-preparer.ts` 有同样的假设，因此两处会一起失效并一起修）。
- 若版本目录位于网络文件系统，`stat` 失败会被判为不完整；这类目录本就不受支持。

## Verification

- `npx vitest run electron/main/managed/launcher-harness-views.test.ts`：6 条（就绪、缺 `bin.js`、缺 `tsx`、入口依赖悬空、入口无 Harness 导入、目录缺失）。
- `launcher-harness-service.test.ts`（46 条）与 `launcher-version-store.test.ts`（4 条）在补 `tsx` fixture 后全过。
- 修复后的 Windows 版本（`versions/66491b05…`）实测 `node_modules/tsx` 与 `apps/cli/node_modules/@deepseek-ai/dsh-app-boot` 均可解析，重装应用后启动正常。
