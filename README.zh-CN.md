# DSHKer Launcher

[English](README.md) · [使用说明](docs/usage.zh-CN.md) · [产品截图](docs/screenshots.md) · [最新版本](https://github.com/ankye/dshker/releases/latest) · [GitHub Actions 构建](https://github.com/ankye/dshker/actions/workflows/package.yml)

## 核心功能

- **一键启动 DSH Web**：准备内置 Harness 初始版本、选择内核提交，并启动标准 DSH Web 命令。
- **内核版本管理**：刷新远端历史、查看提交，并明确切换 Launcher 管理的 DSH 内核。
- **扩展管理**：查看已安装扩展，并浏览 Awesome DSH Plugin 精选目录。
- **控制台与运行标签页**：查看精确进程输出、终止受管进程，并打开进程实际公布的地址。
- **Token 消耗汇总**：只读汇总原生 DSH 会话与每日模型数据，不写入原生 DSH 数据。
- **清晰的数据边界**：Harness、插件、预设、设置与原生 `~/.dsh` 数据分别保存在声明目录，应用不会静默替换它们。

DSHKer Launcher 是面向 macOS 与 Windows 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 桌面启动器。

Launcher 不会替换、迁移或重置 DSH 原生数据。你已有的 `$DSH_HOME` 或 `~/.dsh` 始终归 DeepSeek Harness 所有；切换内核版本时会继续沿用。

![DSHKer Launcher 启动页](docs/assets/screenshots/launch.png)

![版本管理](docs/assets/screenshots/versions.png)

## 安装

1. 打开[最新 GitHub Release](https://github.com/ankye/dshker/releases/latest)。
2. 下载对应平台的安装包：
   - **macOS Apple Silicon**：名称包含 `mac-arm64.dmg` 的资产
   - **Windows x64**：名称包含 `win-x64.exe` 的资产
3. 使用 Release 中的 `checksums.txt` 核对安装包，手动安装后启动 **DSHKer Launcher**。

当前 Release 安装包尚未签名。macOS 可能需要在 Finder 中右键选择“打开”，Windows 可能显示 SmartScreen 提示。请只安装来自本仓库、且已核对校验和的资产；应用不会在后台静默替换自己。

如果仓库尚未发布任何 Release，“最新版本”链接会明确没有可用的更新源。[GitHub Actions 打包记录](https://github.com/ankye/dshker/actions/workflows/package.yml)仍作为短期构建和诊断证据，但不是 Launcher 的更新源。

## 检查 Launcher 更新

打开**设置 → Launcher 设置 → 版本更新**可检查固定的 DSHKer GitHub Release 源。Launcher 启动后也会在后台检查，不阻塞主窗口；仅当 GitHub 返回更高的稳定语义版本时才显示启动提示。网络或更新源失败不会在启动时弹窗打扰，可在设置页查看失败状态并主动重试。

发现新版本后，点击**下载**会在系统浏览器中打开与当前平台严格匹配的 macOS arm64 或 Windows x64 安装包。资产缺失、重复或平台不受支持时会明确报错，不会改选其他文件。由于当前 macOS 与 Windows 安装包尚未签名，安装仍由用户手动完成。

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
2. **控制台**：查看精确进程输出并终止 Launcher 管理的进程。
3. **版本管理**：刷新、切换和查看内核及扩展。
4. **Token 消耗**：查看原生 DSH 会话日志和每日模型汇总。
5. **设置**：管理 DSH 与 Launcher 设置，包括检查新版本。
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

`package.json` 是 Launcher 版本号的唯一来源。`npm run dist:mac-arm64` 与 `npm run dist:win-x64` 分别生成本机未签名安装包。稳定版 `v*` tag 必须与 `v${package.json.version}` 完全一致；两个平台全部构建通过并核验清单、校验和后，GitHub Actions 会创建公开的 latest Release，附带两个安装包、合并后的 `checksums.txt` 和按平台命名的清单。手动触发工作流只上传 Actions Artifact，不会发布 Release。

详细交付流程见 [docs/release.md](docs/release.md)，CI 规则见 [docs/ci.md](docs/ci.md)。

## 开源地址

- [DSHKer Launcher](https://github.com/ankye/dshker)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
