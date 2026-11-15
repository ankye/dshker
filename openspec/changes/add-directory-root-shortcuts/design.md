## Context

0.1.98 把 Launcher 启动的 DSH 固定到页面内 browse 目录选择器：`-auto` 行禁用，插入 Harness 自带的 `dsh-host-directory-picker-browse` 与 `dsh-client-ui-directory-picker-browse`。这解决了远端配对电脑看不到宿主系统选择框的问题，但把“换盘”的负担留给了用户：

- browse 后端 `list(path?)` 在 `path` 缺省时列出宿主 home（`homedir()`），并且只接受完全限定路径。
- browse 客户端从 home 起步，面包屑只在 home 子树之外显示完整祖先链；在 home 内部时面包屑只剩 “Home”，向上没有出口。
- 因此 Windows 的其它盘符、macOS 的 `/Volumes/<卷>` 只能通过在路径框里手打绝对路径到达。

Harness 版本由 DSHKer 跟随切换，不能修改 Harness 源码，所以修复必须落在 Launcher 自有、随应用发布、可随 Harness 版本一起升级的东西上。

## Goals

- 页面内选择器在任意层级都能一键到达另一块磁盘 / 挂载卷，不需要手输路径。
- 到达后仍由同一个 browse 后端列目录、建目录、报错，不引入第二套文件系统语义。
- 不写 `~/.dsh`、不改选中的 Harness checkout、不向用户 profile 安装包、不新增 renderer/IPC 权限。
- 探测失败、卷不可读、盘符无响应时，列表行为与现状完全一致。

## Non-Goals

- 不做搜索、多选、重命名、删除或收藏夹；不改变隐藏条目默认过滤。
- 不等于系统选择器的磁盘侧栏：不显示卷标、容量、图标或排序偏好（Node 无卷标 API）。
- 不改变授权根（Launcher 的 managed roots）与 DSH 自身权限策略的关系：捷径与被浏览的目录一样，受 DSH 进程用户的文件系统权限约束。

## Decisions

### 1. 装饰已挂载的 browse capability，而不是替换后端

Harness 的 seam（`@deepseek-ai/dsh-host-directory-picker`）把 `capability()` 定义为服务生命周期内稳定的对象，`browse` 形状是 `{ kind: 'browse', list, createDirectory }`。Launcher 插件以 `inject: ['directoryPicker']` 注入，取到 capability 后用一层包装替换 `list`：

- 原名 `list` 仍由 Harness 后端实现：完全限定路径校验、`opendir` 流式读取、结果上限与 `truncated`、`DirectoryPickerError` 业务码全部保留。
- 包装只在返回结果前面加上根捷径行，其余字段原样透传。
- `createDirectory` 完全不动，所以新建文件夹的语义、错误码与行为不变。
- 用 `Symbol.for('dshker.directory-roots')` 标记，重复加载不会二次包装。

**替代方案（未采用）**

- 修改 Harness `packages/host|client/directory-picker-browse`：正解，但需要 Harness 发版，且 DSHKer 跟随版本切换会长期维护分叉。用户明确要求不改 Harness 源码。
- Launcher 重写整个 browse 后端：会把路径校验、流式读取、上限与错误码复制一份，Harness 版本一动就失配；本方案只加一层行合并。
- Launcher 自写客户端 UI 替换 Harness 对话框：改动量最大，且要跟着 Harness 的前端基元与槽位合约走。

### 2. 通过 overlay 的相对文件名插入，随应用资源发布

DSH 的 patch loader（`loadOverlayPatches` → `anchorInsertedPluginNames`）会把 `./` 开头的插入名解析为相对 overlay 文件目录的 `file://` URL，再交给 Node 的模块加载器。于是：

- overlay 行：`name: './dshker-directory-roots.mjs'`。
- 打包：`build.extraResources` 把 overlay 与插件都放到 `process.resourcesPath`（开发时是 `app.getAppPath()/resources`），保持并列。
- 插件不 import 任何 npm 包，只用 `node:fs/promises` 与 `node:path`，因此不依赖 profile 或 checkout 的 `node_modules`，也不需要 `dsh plugin add`。

已实测：在隔离 `DSH_HOME` 上用该 overlay 启动真实 `dsh web`（Harness 1f81c04，即 DSHKer 当前固定版本），插件激活，home 列表顶部出现 `CodeS` 与 `DSHKer Launcher 0.1.99-arm64` 两个挂载卷行。

### 3. 根集合与去重规则

- Windows：探测 A–Z 中能 `stat` 为目录的盘符（Node 无卷标/卷列表 API，逐字母探测是唯一不引入依赖的做法）。行名用盘符写法（字母加冒号和路径分隔符）。
- macOS：`/` 加 `/Volumes/*`，每个子项先 `realpath`；形如 `/Volumes/Macintosh HD → /` 的挂载会折叠成 `/` 一条。
- Linux：`/` 加 `/media`、`/mnt`、`/run/media` 下的目录。
- 每层都按以下规则过滤：根等于当前层、根是当前层祖先（向上走已能到达）、根是当前层后代（当前层已把它列为子项）、或已出现在 `entries` 里（Windows 比较忽略大小写与分隔符），都跳过。因此不会出现重复行，也不会在 `/Volumes` 里重复列出卷。

### 4. 失败隔离与延迟预算

- 每个探测（`stat`/`readdir`/`realpath`）都有 250 ms 上限；未响应的盘符（比如断开的网络盘）只丢一行，不拖住列表。
- 枚举结果缓存 10 秒，导航时命中缓存；期间插入的 U 盘最多 10 秒后出现。
- 枚举、缓存、合并的任何异常都被吞掉并返回原 listing 对象；插件不是列表可用性的依赖。
- 已取消的调用（`signal.aborted`）不再追加行。

## Risks

- **seam 形状变化**：`kind`/`list` 是 Harness 的公开 seam 契约；若未来版本改变 `DirectoryPickerListing` 或去掉 browse 形状，包装会退化为“不追加”，不会破坏列表。升级 Harness 固定版本时应复核该文件。
- **每层多出非目录语义的行**：捷径是真实绝对路径，点开由同一个后端列出，不会伪造内容；但它们在 UI 上与普通文件夹同形，这是不修改客户端 UI 的代价。
- **Windows 探测成本**：首次列表多约 26 次 `stat`（并发，上限 250 ms），之后 10 秒内走缓存。
- **半途枚举**：卷父目录读取超时或失败时该次枚举标记为不完整、不进入缓存，下一次列表重试，避免整卷在一个缓存周期内被隐藏。

## Verification

- `npx vitest run resources/dshker-directory-roots.test.mjs`：28 条覆盖祖先/后代/去重、三平台枚举与 realpath 折叠、缓存、失败与取消、装饰一次性与错误透传。
- `npx vitest run electron/main/managed/launcher-dsh-patch.test.ts`：overlay 行按相对名插入、插件与 overlay 同目录、两者都在 extraResources。
- 隔离 `DSH_HOME` + 真实 `dsh web` 启动验证（见 Decisions 2）：插件从应用资源目录加载并改变真实列表，`/Volumes/Macintosh HD` 未重复出现。
