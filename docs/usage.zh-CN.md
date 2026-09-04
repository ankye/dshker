# DSHKer Launcher 使用说明

## 开始前

请从仓库的[最新 GitHub Release](https://github.com/ankye/dshker/releases/latest)下载 macOS arm64 或 Windows x64 安装包。当前安装包尚未签名；请先使用 `checksums.txt` 核对文件，再手动运行安装程序，并按自己的常规方式备份 DSH 原生数据。GitHub Actions Artifact 是短期构建证据，不是 Launcher 更新源。

DSHKer Launcher 不接管 `$DSH_HOME` 或 `~/.dsh`。不要把它移动到 `~/.dshlauncher`，也不要通过删除它来切换版本。

## 第一次启动 DSH

1. 打开 **DSHKer Launcher**。
2. 保持在**启动**页，等待内置 Harness 在后台准备完成。开屏页仍可操作，准备完成前启动按钮保持不可用。
3. 出现启动版本卡片后，确认 DSH 提交并点击**一键启动**。
4. 应用会切换到**控制台**，实时展示精确启动命令与输出。
5. 当 DSH 公布 loopback URL 后，打开**运行**并新增页面。Launcher 会原样使用该地址，不会猜测端口。

## 切换或更新内核

1. 打开**版本管理 → 内核**。
2. 点击**刷新列表**，通过已配置的 HTTPS origin 拉取并重建提交、标签列表。刷新不会切换版本，也不会重启 DSH。
3. 点击**一键更新**、分支或提交行前，先停止 DSH Web。
4. 等待依赖安装与 DSH 构建完成。只有准备成功后，选中版本才会改变。

选中的内核位于 `~/.dshlauncher/harness`，由 Launcher 管理 Git。运行期间不要用其他 Git 客户端编辑、clean、reset 或切换它。

## 管理扩展

- **版本管理 → 扩展**展示 DSH web profile 当前报告的已安装依赖。
- **安装新扩展**从 `~/.dshlauncher/plugins` 中的 `awesome-dsh-plugin` 精选目录读取可安装项。
- 安装和卸载会转发到标准 DSH CLI；Launcher 不会直接写 DSH profile manifest 或原生插件目录。
- 变更扩展前先停止 DSH Web。

## 检查 Launcher 新版本

1. 打开**设置 → Launcher 设置 → 版本更新**。
2. 点击**重新检查**。页面会从检查中进入已是最新、新版本可用或明确的失败状态。
3. 发现新版本后，确认展示的稳定版本号和安装包名称，再点击**下载**。
4. 系统浏览器会打开严格匹配 macOS arm64 或 Windows x64 的 GitHub Release 资产。请在 Release 页面核对 `checksums.txt`，然后手动运行安装程序。

Launcher 启动后也会对同一个固定仓库做后台检查，不延迟主窗口；只有存在更高的稳定语义版本时才显示启动提示。启动检查失败不会弹出警告打扰，设置页会保留失败状态供用户重试。如果 GitHub 尚无公开的 latest Release，或目标平台安装包缺失、重复，检查会明确失败，不会改用 Actions Artifact 或其他平台安装包。

## 控制台与运行

控制台会区分 Launcher 生命周期消息、启动命令、标准输出和标准错误。底部按钮只启动或终止 Launcher 自己创建的进程。日志文件位于 `~/.dshlauncher/logs/dsh-web.log`，可从控制台显示或导出。

运行页提供浏览器式标签，加载由受管进程实际公布的 DSH Web 地址。关闭页面不会停止 DSH；停止 DSH 后页面会被移除，下一次进程必须重新公布地址。

## 排障

| 现象                  | 处理方式                                                                        |
| --------------------- | ------------------------------------------------------------------------------- |
| 启动按钮不可用        | 等待首次内置内核准备完成，再回到启动页重新检测。                                |
| 版本操作被拒绝        | 在启动页或控制台停止 DSH Web 后，再切换内核或扩展。                             |
| DSH 没有就绪          | 打开控制台查看输出和导出的日志；Launcher 不会假设端口。                         |
| Harness 目录异常      | 在 Launcher 设置检查 `~/.dshlauncher/harness`；不要用替换 `~/.dsh` 的方式修复。 |
| 扩展修改失败          | 查看控制台输出；失败时原有 DSH 扩展列表不会改变。                               |
| Launcher 更新检查失败 | 在设置页重试，并确认 GitHub Release 中只有一个严格匹配当前平台的安装包。        |

## 开源与反馈

可在启动页直接打开源码，或访问：

- [DSHKer Launcher 源码与问题反馈](https://github.com/ankye/dshker)
- [DeepSeek Harness 源码](https://github.com/deepseek-ai/deepseek-harness)
