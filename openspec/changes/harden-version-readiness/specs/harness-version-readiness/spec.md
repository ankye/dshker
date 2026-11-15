## Purpose

让受管 Harness 版本的"就绪"判定覆盖依赖层：只有内置 CLI 入口存在、源码启动所需的运行时依赖可解析、且入口引用的 Harness 包能从该版本的 `node_modules` 解析时，版本才算就绪；否则以独立原因判为不完整，避免把损坏的版本当作可用版本复用。

## ADDED Requirements

### Requirement: Readiness proves the dependency layer resolves

Launcher SHALL 仅在受管版本同时满足以下条件时报告就绪：`package.json` 与 `apps/cli/lib/bin.js` 是直接普通文件、`.git` 是仓库条目或 worktree 指针文件、`node_modules/tsx` 可解析为普通文件、且 `apps/cli/lib/bin.js` 中引用的最多两个 `@deepseek-ai/*` 包能从 `apps/cli/node_modules` 解析为普通文件。SHALL NOT 仅凭文件存在就判定就绪。

#### Scenario: Healthy version is ready

- **WHEN** 版本目录包含内置入口、可解析的 `tsx` 与入口引用的 Harness 包
- **THEN** Launcher 报告该版本就绪，状态页、插件操作与启动继续使用它

#### Scenario: Dependency link no longer resolves

- **WHEN** 内置入口存在，但 `node_modules` 中的 workspace 链接指向已不存在的目标
- **THEN** Launcher 报告该版本不完整，原因为依赖树不可解析，且不把它当作可用版本启动

#### Scenario: Source launcher runtime is missing

- **WHEN** 版本目录缺少可解析的 `node_modules/tsx`
- **THEN** Launcher 报告依赖树不可解析，而不是在启动子进程后才报模块缺失

#### Scenario: Entry imports no Harness package

- **WHEN** 内置入口不引用任何 `@deepseek-ai/*` 包
- **THEN** Launcher 只要求 `tsx` 可解析，并以入口实际引用的包集合为准，不额外要求无关包存在

### Requirement: Incomplete versions keep the existing recovery paths

判定为不完整 SHALL 沿用既有处理：非活动版本在下次准备时被移除并重建；活动版本 SHALL NOT 被原地删除，Launcher SHALL 明确提示先切换到其他版本。SHALL NOT 为活动版本新增静默自动重建。

#### Scenario: Switching away from an incomplete active version

- **WHEN** 当前活动版本不完整，用户选择另一个版本
- **THEN** Launcher 准备并切换到新版本，随后清理旧版本目录；切回时重新准备

#### Scenario: Preparing the incomplete active version again

- **WHEN** 用户对同一活动版本再次触发准备
- **THEN** Launcher 拒绝原地删除并返回明确错误，要求先切换版本
