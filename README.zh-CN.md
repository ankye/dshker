# DSH Launcher

[English](README.md) · [使用说明](docs/usage.zh-CN.md) · [产品截图](docs/screenshots.md) · [GitHub Actions 构建](https://github.com/ankye/dsh-launcher/actions/workflows/package.yml)

DSH Launcher 是面向 macOS 与 Windows 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 桌面启动器。它负责准备 Launcher 自己管理的 Harness 内核目录、查看与切换 Git 提交、通过 DSH 原生命令管理扩展、启动 DSH Web，并将启动日志集中展示。

Launcher 不会替换、迁移或重置 DSH 原生数据。你已有的 `$DSH_HOME` 或 `~/.dsh` 始终归 DeepSeek Harness 所有；切换内核版本时会继续沿用。

![DSH Launcher 启动页](docs/assets/screenshots/launch.png)

## 可以做什么

- 当 `~/.dshlauncher/harness` 为空时，自动准备安装包内置的 Harness 初始版本。
- 查看远端提交历史、刷新版本列表，并明确切换 DSH 内核提交。
- 查看已安装 DSH 扩展，并浏览 Awesome DSH Plugin 的精选目录。
- 启动和终止标准 DSH Web 命令，实时查看输出，并在多个标签页打开进程实际公布的本地页面。
- 只读汇总 DSH 会话日志中的 Token 消耗，不写入原生 DSH 数据。

![版本管理](docs/assets/screenshots/versions.png)

## 安装

1. 打开最新一次成功的 [打包工作流](https://github.com/ankye/dsh-launcher/actions/workflows/package.yml)。
2. 下载对应平台的 Artifact：
   - **macOS Apple Silicon**：`dsh-launcher-macos-arm64`（`.dmg`）
   - **Windows x64**：`dsh-launcher-windows-x64`（`.exe`）
3. 安装后启动 **DSH Launcher**。

GitHub Actions 当前提供的是未签名构建产物，保留 14 天。macOS 可能需要在 Finder 中右键选择“打开”，Windows 可能显示 SmartScreen 提示。请只安装来自本仓库、且已核对 `checksums.txt` 的产物；签名与 macOS 公证属于独立发布流程。

## 首次启动

首次运行会自动建立以下 Launcher 自己管理的目录：

| 目录                      | 用途                                   |
| ------------------------- | -------------------------------------- |
| `~/.dshlauncher/harness`  | 选中的 DeepSeek Harness 内核与构建产物 |
| `~/.dshlauncher/plugins`  | 精选插件目录源代码                     |
| `~/.dshlauncher/presets`  | Launcher 下载的预设源代码              |
| `~/.dshlauncher/settings` | Launcher 偏好与记录                    |

若 Harness 目录为空，应用会在后台解压内置 DSH、安装锁定依赖并构建。准备完成前“一键启动”保持不可用，但主界面不会被阻塞。

需要时可按侧边栏顺序使用：

1. **启动**：确认选中提交并启动 DSH Web。
2. **高级选项**：查看 Launcher 管理的目录与工具设置。
3. **版本管理**：刷新、切换和查看内核及扩展。
4. **控制台**：查看精确进程输出并终止 Launcher 管理的进程。
5. **设置**：设置主题、语言和 npm 加速偏好。
6. **运行**：在独立标签页中打开进程实际公布的地址。

完整步骤、排障方式与目录归属说明见[中文使用说明](docs/usage.zh-CN.md)或[英文使用说明](docs/usage.en.md)。

## 本地开发

需要 Node.js `^20.19.0 || >=22.12.0` 与 npm `>=10`。

```bash
npm ci
npm run dev
```

常用检查：

```bash
npm run environment:check
npm run format:check
npm run architecture:check
npm run type-check
npm test -- --run
npm run service:smoke
npm run visual:smoke
npm run build:electron
```

## 打包与发布

`npm run dist:mac-arm64` 与 `npm run dist:win-x64` 分别生成本机未签名安装包。推送 `v*` tag 会触发 GitHub Actions，构建相同的两个平台并上传 `checksums.txt`、`release-manifest.json` 和安装包 Artifact。未配置签名与 macOS 公证前，工作流不会创建 GitHub Release。

详细交付流程见 [docs/release.md](docs/release.md)，CI 规则见 [docs/ci.md](docs/ci.md)。

## 开源地址

- [DSH Launcher](https://github.com/ankye/dsh-launcher)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
