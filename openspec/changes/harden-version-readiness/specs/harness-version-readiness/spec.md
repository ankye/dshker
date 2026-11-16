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

### Requirement: The Launcher Core can explicitly retry an incomplete version in place

Launcher Core 的版本判定为不完整时，SHALL 阻止启动与插件操作并保留版本选择。用户显式选择版本后，Launcher SHALL 在现有工作目录完成依赖安装、构建和就绪校验。SHALL NOT 删除工作目录或自动重建。

#### Scenario: Retrying the incomplete version

- **WHEN** 用户再次选择依赖不完整或准备中断的版本
- **THEN** Launcher 在同一目录重试准备，校验成功后方可启动
