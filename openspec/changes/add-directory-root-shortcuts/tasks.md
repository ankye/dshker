## 1. Implementation

- [x] 1.1 新增 Host 插件 `resources/dshker-directory-roots.mjs`：以 `inject: ['directoryPicker']` 装饰 browse capability，在 `list` 结果前追加根捷径；只用 Node 内建模块。
- [x] 1.2 实现三平台根枚举：Windows 盘符探测、macOS `/Volumes/*`（`realpath` 折叠到 `/`）、Linux `/media`、`/mnt`、`/run/media`；单项 250 ms 上限与 10 秒缓存。
- [x] 1.3 实现祖先/后代/已列子项去重与 Windows 大小写、分隔符归一，保证不重复、不在 `/Volumes` 重复列卷。
- [x] 1.4 失败隔离：枚举或探测异常、调用已取消时返回原 listing；不改 `createDirectory` 与 Harness 错误码。
- [x] 1.5 overlay 以 `./dshker-directory-roots.mjs` 相对名插入，并说明按 overlay 目录解析。
- [x] 1.6 `build.extraResources` 将插件与 overlay 并列发布；`vitest.config.ts` 收集 `resources/**/*.test.mjs`。

## 2. Tests

- [x] 2.1 `resources/dshker-directory-roots.test.mjs`：28 条覆盖祖先/后代/去重、三平台枚举与 realpath 折叠、缓存、失败与取消、装饰一次性、后端错误透传、`apply` 无服务时不抛错。
- [x] 2.2 `electron/main/managed/launcher-dsh-patch.test.ts`：overlay 行按相对名插入、插件文件与 overlay 同目录且导出 `name`/`inject`/`apply`、两者都在 extraResources。
- [x] 2.3 隔离 `DSH_HOME` + 真实 `dsh web`（Harness 1f81c04）启动验证：插件从资源目录加载，home 列表顶部出现两个真实挂载卷，`/Volumes/Macintosh HD` 未重复。

## 3. Evidence

- [x] 3.1 Agent Note：`.agents/notes/2026-11-15-directory-root-shortcuts.md`（现象、机制、验证命令与结果、限制）。
- [x] 3.2 CHANGELOG `Unreleased` 中英条目。
- [x] 3.3 README 复核：两份 README 均未描述选择器的目录来源，本次不使其过期，无需改动。

## 4. Validation

- [x] 4.1 `npm run environment:check`
- [x] 4.2 `npm run format:check`
- [x] 4.3 `npm run architecture:check`
- [x] 4.4 `npm run type-check`
- [x] 4.5 `npm test -- --run`（212 个测试文件：211 passed / 1 skipped；2095 条测试：2093 passed / 2 skipped）
- [x] 4.6 `npm run build`
- [x] 4.7 `npm run build:electron`
- [x] 4.8 `npm run service:smoke`、`npm run visual:smoke`
- [x] 4.9 工作区门禁 `node tools/validate-desktop-app.mjs --app apps/dsh-launcher --json`（驱动字母与 `/Users` 字面量已改为 `resources`/fixture 内组装，门禁 ok）
- [x] 4.10 `npx openspec validate add-directory-root-shortcuts --strict`
- [x] 4.11 Windows 实机（Windows 11 10.0.26200，DSHKer node 22.23.3）：`collectRoots('win32')` 返回 C:/D:/E:/F:，`addRootShortcuts` 只追加 D:/E:/F:，三个盘 `readdir` 均成功
- [x] 4.12 Windows 实机页面内 UI：重建受管版本后，真实对话框在"主目录"下列出 D:/E:/F:，点击 D: 切换成功并列出该盘内容（截图 dsh-win-ui-4.png、dsh-win-ui-5.png）
- [x] 4.13 Windows 实机 overlay 集成：真实 `dsh web` 加载 Launcher overlay 与观察插件，home 列表前 3 项为 D:/E:/F:，三盘 list 成功
