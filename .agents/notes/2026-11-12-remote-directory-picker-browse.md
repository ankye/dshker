# 远程目录选择改用页面内浏览器

## 现象

Windows 经 P2P 打开 Mac 的 DSH 工作台，点击选择文件夹报
`directory picker failed: ... /api/directoryPicker/pick: HTTP 502`。

## 原因

Mac `core-diagnostics.log` 记录 `proxy POST /api/directoryPicker/pick: net/http:
timeout awaiting response headers`：请求已经过隧道到达 Mac 的 DSH，DSH 没有在
`ResponseHeaderTimeout` 70 秒内回复，被访问端代理返回 502。同期会话健康正常。

Harness bundle 的 `directory-picker` 行是 `-auto`。它在 127.0.0.1 绑定、非 SSH
启动、darwin/win32 上选 `native`，`pick` 用 `osascript` 在 Mac 屏幕打开
`NSOpenPanel`。远程访问方看不到这个窗口。Launcher 和 Harness 历史中没有
Launcher 固定过选择器；0.1.48 起的 Launcher 授权根浏览一直返回空根，其面板
在 0.1.65 随配对面板一起下线。

## 修改

Launcher 自有的 `dsh web --patch` overlay（`resources/dsh-launcher-verbose-logging.patch.yml`）
禁用 `directory-picker` 行，插入 Harness 自带的
`@deepseek-ai/dsh-host-directory-picker-browse` 与
`@deepseek-ai/dsh-client-ui-directory-picker-browse`，与 Harness
`apps/web/tests/pin-browse-picker.overlay.yml` 相同的组合方式。未修改 Harness、
`~/.dsh` 或 SSH 环境。本机也随之使用页面内选择。

浏览器后端可列出 DSH 进程用户可访问的目录，与原 `-auto` 在 SSH/非 loopback 下
的行为相同；它不受 Launcher 授权根约束。工作区打开仍由远端 DSH 自身权限处理。

## 验证

- 对选定 Harness `1f81c04` 运行 `--dump-config`：`directory-picker` 为 disabled，
  两个 browse 行已插入。
- 用该 overlay 在隔离 `DSH_HOME` 启动真实 `dsh web`：`directoryPicker/list`
  HTTP 200 返回目录；`pick` 立即返回 `directory-picker/unavailable`（browse 不提供
  native pick），页面加载 `ui-directory-picker-browse`。
- 新增 `electron/main/managed/launcher-dsh-patch.test.ts`。

未在两台实机上点击验证 Windows→Mac 的界面交互；安装版需要发布新包后才生效。
Node profile（`ProfileNode`）启动不带 `--patch`，不受此修改影响。
