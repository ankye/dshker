## Why

0.1.98 起 Launcher 把自己的 `--patch` overlay 里的 `directory-picker`（`-auto`）禁用，改为固定 Harness 的页面内目录浏览器，因为远端配对电脑看不到宿主机屏幕上弹出的系统选择框（会等到代理 502）。但这套页面内浏览器只从宿主 home 开始、面包屑只沿祖先链向上：Windows 上换到另一块磁盘、macOS/Linux 上打开挂载卷，都只能在路径框里手工输入。用户反馈“切换磁盘不方便，要手动输入磁盘”，而 Harness 源码不能改（版本不停切换，只跟版本走）。

## What Changes

- 新增 Launcher 自有的 DSH Host 插件 `resources/dshker-directory-roots.mjs`，通过装饰已挂载的 `browse` 目录选择能力，在每一层目录列表前面加上当前层走不到的根：Windows 盘符（字母加冒号，如 `D:`）、macOS `/Volumes/*`、Linux `/media`、`/mnt`、`/run/media` 下的挂载点。
- 该插件不经 `~/.dsh`、不改选中的 Harness checkout、不安装进 profile：overlay 用相对文件名 `./dshker-directory-roots.mjs` 插入，DSH 的 patch loader 按 overlay 文件所在目录解析；插件随应用以 extraResources 与 overlay 并列发布。
- 插件只用 Node 内建模块，不依赖任何 npm 包，因此从应用资源目录即可加载；磁盘探测带超时和 10 秒缓存，探测失败时原列表原样返回（不影响浏览、创建目录和 Harness 自身的错误码）。
- 扩展 overlay 准入测试：断言该行按相对名插入、插件文件与 overlay 同目录、并且两者都在打包资源清单里。

不改动 Harness 源码、Harness 版本固定、`dsh web` 启动方式、原生选择器语义或工作区授权规则；不新增 renderer 权限、IPC 操作或持久化字段。

## Capabilities

### New Capabilities

- `directory-root-shortcuts`: 页面内目录选择器在每个层级提供当前层无法通过向上导航到达的磁盘/挂载卷捷径，且这些捷径是同一 browse 后端可直接列出的真实绝对路径。

### Modified Capabilities

None.

## Impact

- `resources/dsh-launcher-verbose-logging.patch.yml`：新增一行 `dshker-directory-roots` 插入。
- `resources/dshker-directory-roots.mjs`（新）：Host 插件实现；`resources/dshker-directory-roots.test.mjs`（新）：单元测试。
- `package.json`：`build.extraResources` 增加该插件文件，保持与 overlay 的并列几何。
- `vitest.config.ts`：测试收集范围增加 `resources/**/*.test.mjs`。
- `electron/main/managed/launcher-dsh-patch.test.ts`：overlay 与打包几何准入测试。
- 用户可见变化：页面内选择器顶部多出磁盘/卷行；不改动既有目录浏览、新建文件夹、取消与错误提示行为。
