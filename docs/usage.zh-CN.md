# DSH Launcher 使用说明

## 开始前

请从仓库的 GitHub Actions 打包工作流下载 macOS arm64 或 Windows x64 Artifact。当前 Artifact 是未签名构建证据，不是已签名的公开发行包；打开安装程序前请核对 `checksums.txt`，并按自己的常规方式备份 DSH 原生数据。

DSH Launcher 不接管 `$DSH_HOME` 或 `~/.dsh`。不要把它移动到 `~/.dshlauncher`，也不要通过删除它来切换版本。

## 第一次启动 DSH

1. 打开 **DSH Launcher**。
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

## 控制台与运行

控制台会区分 Launcher 生命周期消息、启动命令、标准输出和标准错误。底部按钮只启动或终止 Launcher 自己创建的进程。日志文件位于 `~/.dshlauncher/logs/dsh-web.log`，可从控制台显示或导出。

运行页提供浏览器式标签，加载由受管进程实际公布的 DSH Web 地址。关闭页面不会停止 DSH；停止 DSH 后页面会被移除，下一次进程必须重新公布地址。

## 排障

| 现象             | 处理方式                                                                  |
| ---------------- | ------------------------------------------------------------------------- |
| 启动按钮不可用   | 等待首次内置内核准备完成，再回到启动页重新检测。                          |
| 版本操作被拒绝   | 在启动页或控制台停止 DSH Web 后，再切换内核或扩展。                       |
| DSH 没有就绪     | 打开控制台查看输出和导出的日志；Launcher 不会假设端口。                   |
| Harness 目录异常 | 在高级选项检查 `~/.dshlauncher/harness`；不要用替换 `~/.dsh` 的方式修复。 |
| 扩展修改失败     | 查看控制台输出；失败时原有 DSH 扩展列表不会改变。                         |

## 开源与反馈

可在启动页直接打开源码，或访问：

- [DSH Launcher 源码与问题反馈](https://github.com/ankye/dsh-launcher)
- [DeepSeek Harness 源码](https://github.com/deepseek-ai/deepseek-harness)
