## Why

2026-11-15 在一台 Windows 上发现：受管版本目录 `versions/<commit>` 的 `apps/cli/node_modules/@deepseek-ai/*`（135 个）与根 `node_modules/@deepseek-ai/*`（37 个）workspace junction 全部无法解析，`dsh web` 启动后在 `@deepseek-ai/dsh-app-boot` 处抛 `ERR_MODULE_NOT_FOUND`。但 `readHarnessReadiness` 只检查 `package.json`、`apps/cli/lib/bin.js` 和 `.git` 是否存在，于是把这个版本判为"已就绪"：状态页显示就绪、版本切换直接复用、重装应用也复用，用户看到的是启动后的模块错误，而不是"版本不完整"。修复该目录必须靠重建 worktree + 重装依赖，因此检测必须在复用之前发生。

## What Changes

- `readHarnessReadiness` 增加依赖层证明：除既有文件和 `.git` 检查外，要求源码启动所需的 `node_modules/tsx` 可解析，并要求内置入口 `apps/cli/lib/bin.js` 中引用的最多两个 `@deepseek-ai/*` 包能从 `apps/cli/node_modules` 解析成普通文件。
- 新增独立的失败原因 `The Launcher Harness directory has an unresolvable dependency tree.`，与"缺少内置 checkout"区分，使状态页、插件操作与版本准备给出可执行的结论。
- 判定为 `invalid` 后沿用既有路径：非活动版本在下次准备时被 `removeInterruptedVersion` 删除并重建；活动版本明确拒绝原地准备并提示先切换版本（避免删除正在使用的目录）。
- 新增单元测试覆盖就绪、缺 `tsx`、入口依赖悬空、入口无 Harness 导入、缺 `bin.js`、目录缺失六种情形；更新两个既有 fixture 以包含 `tsx`。

不改动启动方式、overlay、profile、版本目录布局或 IPC 契约；不为损坏的自管版本新增自动重建或修复按钮（活动版本原地重建仍是显式非目标）。

## Capabilities

### New Capabilities

- `harness-version-readiness`: 受管 Harness 版本只有在内置入口与它依赖的模块层都能解析时才算就绪；否则以独立原因判为不完整，而不是在启动后失败。

### Modified Capabilities

None.

## Impact

- `electron/main/managed/launcher-harness-views.ts`：就绪判定与解析辅助函数。
- `electron/main/managed/launcher-harness-views.test.ts`（新）：6 条就绪判定测试。
- `electron/main/managed/launcher-version-store.test.ts`、`electron/main/managed/launcher-harness-service.test.ts`：fixture 补 `node_modules/tsx`。
- 用户可见变化：损坏版本在启动前被识别为不完整，并提示切换版本；正常版本行为不变（多一次 `bin.js` 读取与 1–3 次 `stat`）。
