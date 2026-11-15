# Agent Note: in-page picker disk/volume shortcuts

## Symptom

DSHKer 的“选择工作区”打开的是 Harness 的页面内目录浏览器（0.1.98 起由
Launcher overlay 固定）。该浏览器从宿主 home 起步，面包屑只在 home 子树之外
显示完整祖先链，因此 Windows 换到另一块磁盘、POSIX 打开挂载卷都只能在路径输入框
里手打绝对路径。用户反馈“切换磁盘不方便，要手动输入磁盘”。

## Constraint

Harness 版本由 DSHKer 跟随切换，不能改 Harness 源码（`packages/host/directory-picker-browse`
与 `packages/client/ui-directory-picker-browse`），也不能把补丁装进用户 profile
或 `~/.dsh`。因此修复必须是 Launcher 自有、随应用发布、对任何已安装 Harness
版本都成立的扩展。

## Mechanism

`resources/dshker-directory-roots.mjs` 是一个 Host 侧 Cordis 插件，由
`resources/dsh-launcher-verbose-logging.patch.yml` 以相对名
`./dshker-directory-roots.mjs` 插入。DSH 的 patch loader
（`anchorInsertedPluginNames`）把 `./` 开头的插入名解析为相对 overlay 目录的
`file://` URL；插件只用 `node:fs/promises`、`node:path`，所以不需要
`node_modules` 或安装步骤。overlay 与插件都由 `build.extraResources` 放到
应用资源目录，保持并列，开发态则是 `resources/` 自身。

插件 `inject: ['directoryPicker']`，取 `capability()`；仅当 `kind === 'browse'`
时用一层包装替换稳定的 capability 对象的 `list`，在结果前追加根捷径。
Harness 后端继续负责完全限定路径校验、流式读取、结果上限、`truncated` 与
`DirectoryPickerError` 业务码；`createDirectory` 不动。装饰用
`Symbol.for('dshker.directory-roots')` 标记，重复加载不会二次包装。

根集合：Windows 逐字母探测 A 到 Z 的盘符根（Node 无卷标 API）；macOS `/` 加
`/Volumes/*`（先 `realpath`，`/Volumes/Macintosh HD → /` 折叠成一条）；
Linux `/` 加 `/media`、`/mnt`、`/run/media`。每层跳过等于当前层、是当前层祖先
（向上可达）、是当前层后代（已列为子项）或已出现在 `entries` 里的根，Windows
比较忽略大小写与分隔符。探测单项 250 ms 上限，枚举缓存 10 秒；卷父目录读取失败时该次
枚举视为不完整、不进入缓存，下一次列表重试。枚举或探测的任何异常、以及已
取消的调用，都返回原 listing 对象。

## Verification

- `npx vitest run resources/dshker-directory-roots.test.mjs`：28 passed。
- `npx vitest run electron/main/managed/launcher-dsh-patch.test.ts`：3 passed
  （相对名插入、插件与 overlay 同目录、extraResources 几何）。
- 隔离 `DSH_HOME=/tmp/...` 用同一份 overlay 启动真实 `dsh web`
  （Harness `1f81c04`，`--port 0 --no-open`），附加一个观察插件在 2 秒后调用
  `capability().list(undefined)`：返回的 `entries` 顶部为 `CodeS` 与
  `DSHKer Launcher 0.1.99-arm64` 两个真实挂载卷，`/Volumes/Macintosh HD`
  因解析为 `/` 未重复出现。该启动只用于验证，未改动用户 `~/.dsh` 或任何
  Harness checkout。

## Windows hardware verification

2026-11-15，通过 SSH 在一台 Windows 11（10.0.26200）上用 DSHKer 自带的
`node` 22.23.3 直接执行生产插件代码（不经过任何测试替身）：

- `collectRoots('win32')` → C 盘、D 盘、E 盘、F 盘，home 为该用户的用户目录；
- `addRootShortcuts` 只追加 D 盘、E 盘、F 盘，home 所在盘按规则排除；
- 三个盘逐个 `readdir` 成功（41 / 22 / 34 个子项），即选择器点进去列得出来。

同一台机器的受管 checkout（`versions\66491b05…`）当时不可用于重启 DSH：
`apps\cli\node_modules\@deepseek-ai` 下 135 个、根 `node_modules\@deepseek-ai` 下
37 个 workspace junction 全部无法解析，新版 Node 报"路径包含递归的装入点"，
`dsh web` 会在 `@deepseek-ai/dsh-app-boot` 解析处失败。该状态与本次改动无关（本次
只写入临时目录，未写 checkout）；同一目标新建 junction 可正常遍历，说明是 reparse
point 自身损坏而非目标缺失。因此 Windows 上的 overlay + 页面内 UI 截图验证暂时无法
执行，留待该 checkout 修复后或下一次发布的干净安装上补做。

就地修复尝试（`pnpm install --frozen-lockfile`、`--force`、`--ignore-scripts`
三档）都没有成功：pnpm 在链接阶段之前就遇到同样的不可读 reparse point，
`--force` 还在 `open …\.pnpm\…\zod\package.json` 上报 `UNKNOWN`，最后以
`[ELIFECYCLE]` 退出；`--ignore-scripts` 则因为 esbuild/koffi 的 postinstall 需要
registry（当时约 22 KiB/s）而失败。`fsutil dirty query C:` 显示卷未标脏，`cmd type`
能读其中一部分路径而 PowerShell/Node 不能，形态更像是该目录里被中断安装留下的
半成品 reparse point，而不是卷损坏。结论：可靠修复是让 Launcher 重新准备这一版本
（删除 `versions/66491…` 后重新 worktree + install），而不是原地重装。

顺带记录一个可选的加固点：`readHarnessReadiness` 只检查 `package.json` 与
`apps/cli/lib/bin.js`，不检查 `node_modules` 是否可用，所以损坏的版本会被判为
"已就绪"并一直复用；`worktree-preparer.ts` 的 `assertSourceLauncher` 已经检查了
`node_modules/tsx`，但 `dsh web` 启动路径没有用这份断言。

修复与界面验证（同日晚些时候）：把 `versions/66491…` 改名挪开后
`git worktree prune` + `git worktree add --detach` 重建干净工作树，
用 `pnpm install --frozen-lockfile --registry https://registry.npmmirror.com`
（43 秒完成）与 `pnpm run build`（10 个 gate 全过）恢复，`node_modules/tsx` 与
`apps/cli/node_modules/@deepseek-ai/dsh-app-boot` 均可解析。随后用这份重建的 Host
启动 `dsh web`（同一 overlay + 观察插件，隔离 `DSH_HOME`）：

- `directoryPicker` 返回的 home 列表前 6 项为 D 盘、E 盘、F 盘、`.agents`…；
- 逐个 list 三个盘成功：D: 39、E: 25、F: 26 个子项。

界面验证（无头 Chrome + `ssh -L` 转发到本机，真实 Windows Host）：页面内
"选择工作区目录"对话框在"主目录"下列出 D 盘、E 盘、F 盘三个捷径，点击 D 盘后
对话框切到 D 盘并列出该盘真实内容，同时左侧捷径变为 C 盘、E 盘、F 盘
（home 盘出现的规则）。证据截图：`dsh-win-ui-4.png`（home 列表）与
`dsh-win-ui-5.png`（切到 D: 之后）。

遗留：旧的损坏目录被改名为 `versions/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db-junk`
（不可用 `rd /s` 删除，里面 `.pnpm` 链接指向全局 store），需要安全的删除方式；
Windows 上的 DSH 已停止，重启 DSHKer 会从重建后的版本启动。

## Limits

未在 Windows 实机确认盘符行的显示与进入（本机为 macOS），该项留在 OpenSpec
tasks 的未完成条目里。捷径行在 UI 上与普通文件夹同形，不显示卷标、容量或图标；
这是不替换 Harness 客户端 UI 的代价。若未来 Harness 版本改变 browse capability
形状，包装会退化为不追加，列表本身不受影响；升级固定版本时应复核该文件。
