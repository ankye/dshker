## 1. Implementation

- [x] 1.1 `readHarnessReadiness` 增加依赖层证明：`node_modules/tsx` 可解析 + 内置入口引用的最多两个 `@deepseek-ai/*` 包可解析。
- [x] 1.2 依赖失败使用独立原因 `The Launcher Harness directory has an unresolvable dependency tree.`，保留原有"缺少内置 checkout"原因。
- [x] 1.3 恢复路径不变：非活动版本删除重建，活动版本拒绝原地准备并提示切换。

## 2. Tests

- [x] 2.1 新增 `launcher-harness-views.test.ts`：就绪、缺 `bin.js`、缺 `tsx`、入口依赖悬空、入口无 Harness 导入、目录缺失。
- [x] 2.2 更新 `launcher-version-store.test.ts` 与 `launcher-harness-service.test.ts` fixture，补 `node_modules/tsx`。

## 3. Evidence

- [x] 3.1 Agent Note：`.agents/notes/2026-11-16-version-readiness-dependencies.md`。
- [x] 3.2 CHANGELOG `0.1.100` 条目（中英）。

## 4. Validation

- [x] 4.1 `npx vitest run electron/main/managed/launcher-harness-views.test.ts electron/main/managed/launcher-version-store.test.ts electron/main/managed/launcher-harness-service.test.ts`（56 passed）
- [x] 4.2 `npm run type-check`、`npm run format:check`、`npm run architecture:check`
- [x] 4.3 `npm test -- --run`（全量）
- [x] 4.4 `npx openspec validate harden-version-readiness --strict`
