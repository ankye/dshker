# Agent Note: readiness proves the dependency layer

## Finding

2026-11-15 的 Windows 实机验证发现受管版本 `versions/66491b05…` 的
`apps/cli/node_modules/@deepseek-ai`（135 个）与根 `node_modules/@deepseek-ai`
（37 个）workspace 链接全部无法解析：`stat` 报 `UNKNOWN`，`cmd dir` 报找不到，
但目标目录存在、同名新建 junction 可正常遍历。`dsh web` 因此在
`@deepseek-ai/dsh-app-boot` 处抛 `ERR_MODULE_NOT_FOUND`。

`readHarnessReadiness` 当时只检查 `package.json`、`apps/cli/lib/bin.js` 与 `.git`，
于是这份已损坏的版本被判为"已就绪"：

- 状态页显示就绪，启动时才在子进程里失败；
- 切回同一版本直接复用（`materializeLauncherVersion` 的 ready 分支不重装）；
- 重装应用保留 `~/.dshlauncher`，pointer 仍指向它，同样复用。

此外 `worktree-preparer.ts` 的 `assertSourceLauncher` 已经要求
`node_modules/tsx`，但 `dsh web` 启动路径没有用这份断言。

## Change

`readHarnessReadiness` 在既有的文件与 `.git` 检查之后，新增依赖层证明：

- `node_modules/tsx/package.json` 必须可解析为普通文件（Web 子进程通过
  `pnpm dsh` 运行 `node --import tsx/esm apps/cli/src/bin.ts`）；
- 从内置入口 `apps/cli/lib/bin.js` 中提取最多两个 `@deepseek-ai/*` 引用，要求
  `apps/cli/node_modules/<name>/package.json` 可解析。

`assertDirectRegularFile` 拒绝符号链接组件，所以新增
`assertResolvableRegularFile` 用 `stat` 跟随链接：链接层不可解析时它直接失败，
这正是要检测的状态。失败原因独立为
`The Launcher Harness directory has an unresolvable dependency tree.`，与"缺少内置
checkout"区分。恢复路径不变：非活动版本由 `removeInterruptedVersion` 删除重建，
活动版本继续拒绝原地准备（不删除正在使用的目录），提示先切换版本。

成本：每次就绪读取多一次 `bin.js` 读取与 1–3 次 `stat`，不遍历 `node_modules`。

## Verification

- 新增 `electron/main/managed/launcher-harness-views.test.ts` 6 条：就绪、缺
  `bin.js`、缺 `tsx`、入口依赖悬空（dangling symlink）、入口无 Harness 导入、
  目录缺失。
- `launcher-version-store.test.ts`（4 条）与 `launcher-harness-service.test.ts`
  （46 条）在 fixture 补 `tsx` 后全过；全量 Vitest 见发布记录。
- 修复后的 Windows 版本上，`node_modules/tsx` 与
  `apps/cli/node_modules/@deepseek-ai/dsh-app-boot` 均可解析，`dsh web` 正常启动。

## Limits

没有为活动版本增加自动重建：删除正在被应用使用的版本目录风险高于收益，显式切换
版本已经能恢复。也没有校验完整依赖闭包——那等于重新实现包管理器；这里只证明链接层
可用与入口声明的依赖可解析。
