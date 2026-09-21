<p align="center">
  <img src="resources/dsh-launcher-logo-launcher.png" alt="DSHKer 水獭品牌 Logo" width="128" />
</p>

# DSHKer Launcher

**把 DeepSeek Harness 当应用来用。** 装好、点一下开始，就能开工——在这台电脑上，或在你任何一台其它电脑上，同一个窗口里。

[English](README.md) · [使用说明](docs/usage.zh-CN.md) · [产品截图](docs/screenshots.md) · [最新版本](https://github.com/ankye/dshker/releases/latest) · [GitHub Actions 构建](https://github.com/ankye/dshker/actions/workflows/package.yml)

## 它能为你做什么

- **点一下就开始。** Launcher 替你准备好并启动标准 DSH Web 会话：不用手动装东西，不用记命令，也不用一直开着一个终端窗口。
- **换版本不冒险。** 看清有哪些内核可用，想用新的就切换，出问题了再切回来。
- **把所有电脑放进一个窗口。** 把已经在用的机器加进来，每台在“本地”旁边各占一个页签——不用手抄 DSH 凭据，也不用把端口开到公网。
- **连接，但不暴露自己。** 设备之间逐台认证：哪些电脑可以互相访问由你决定，远程会话只能浏览你授权给它的目录。
- **看得见在发生什么。** 控制台跟着真实进程输出，Token 消耗汇总直接读 DSH 自己写的日志。
- **数据始终是你的。** Harness、插件、预设、设置与原生 `~/.dsh` 目录都留在原地：Launcher 只是沿用，绝不静默替换或重置。
- **旧机器自己收尾。** 在新电脑上登录就会自动登记上线；移除一台会带走它的配对；你选过的网络会被记住；一台已经不在当前网络里的电脑会明确说明，而不是悄悄消失。

DSHKer Launcher 是面向 macOS 与 Windows 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 桌面启动器。

Launcher 不会替换、迁移或重置 DSH 原生数据。你已有的 `$DSH_HOME` 或 `~/.dsh` 始终归 DeepSeek Harness 所有；切换内核版本时会继续沿用。

![DSHKer 水獭工作台——当前启动页使用的品牌背景插画](resources/dshker-hero-workbench.png)

上方 Logo 与工作台插画直接复用当前源码中的应用素材。界面实拍见[产品截图](docs/screenshots.md)；已发布安装包可能落后于 `main` 分支。

## 远程连接

把多台电脑的 DSH 集中到同一个桌面入口，无需将 DSH Web 暴露到网络。当前桌面连接方式为 **SSH 隧道**，将 HTTP 与 WebSocket 流量转发到远端 DSH 实际使用的回环地址和端口。

- **电脑管理**：SSH 页面只保留电脑列表和一个明确的“添加电脑”入口；表单在带关闭按钮的弹窗中打开。可填写名称、主机、SSH 端口、用户名和可选的本机 SSH Key 路径，支持编辑连接记录、删除不再使用的电脑；修改 SSH 目标或 Key 路径前需先断开，修改后原测试结果失效，需要重新测试。
- **先测试，再连接**：验证 SSH 认证、远端 DSHKer 握手及 DSH 访问。测试通过与正在连接是两个独立状态。
- **状态一目了然**：绿色表示就绪或测试通过，红色表示失败，同时显示文字状态；已配对的计算机会自行连接与重连，需要时也可主动断开。
- **按需运行页签**：保留一个本地页签；运行页点击“+”后从浮层中的“局域网电脑”或“SSH 连接”列表选择，才创建对应的不可关闭远程页签。可建立连接的设备排在前面，暂不可用的设备保留在底部并置灰，断开连接不会删除已打开的页签。
- **无需手动复制 DSH Token**：通过已认证链路获取 DSH Web 凭据。仍需配置 SSH 认证；可为每台电脑指定本机 SSH Key 路径，应用不接收密码，也不读取或传输私钥内容。
- **升级后保持登录**：账号会话保存在系统凭据存储中。启动或安装新版本后，界面先显示恢复进度并自动刷新；只有服务器明确判定会话失效时才需要重新登录。

连接步骤：

1. 在远端电脑运行 DSHKer，并确认它能够启动受管 DSH Web 会话。
2. 配置远端 SSH 服务，通过系统 OpenSSH 配置、agent 或本机 Key 路径验证访问，并完成主机密钥信任校验。
3. 打开**远程连接**，填写电脑信息，先点**测试**，再点**连接**；进入**运行**后点击页签栏“+”，从 SSH 列表选择这台电脑。

表单填写的是 **SSH 端口**，不是 DSH Web 端口。DSHKer 获取实际 DSH 地址，不假定端口为 `3080`。若提示 `remote.peer_unavailable`，请检查远端 DSHKer 是否运行、能否提供 DSH 会话；仅 SSH 服务可访问还不够。

### 自托管 P2P 远程工作台

通过你自己托管的协调服务器，在你的两台电脑之间建立直连，无需把 DSH Web 暴露到网络，也不需要 SSH 隧道。独立的 [DSHKer Server](https://github.com/ankye/dshker-server) 提供分用户网络与认证设备配对。

桌面端实现与自动化测试已完成：同一网络内设备的自动配对、连接阶段状态、每台电脑独立隔离的浏览器会话、远端授权目录浏览与工程选择、共享服务器配置编辑，以及断线后的任务核对。

在**远程连接 → 网络与账户**中，登录后只保留当前账号和网络工作台。网络通过一个下拉菜单选择，旁边的**创建网络**按钮打开弹窗；选中网络后直接查看网络 ID、设备上限和电脑列表，名称、上限与删除集中在**管理网络**弹窗中。账号技术 ID、本机登记恢复和配对面板不再重复占据主工作区。

工作台现在只保留一个清晰的主层级，内部用留白和行分隔代替重复的嵌套边框；网络 ID、在线状态和所有操作仍然完整保留。

加入网络后，“我的网络”会直接显示当前加入的网络 ID，并提供复制按钮；设备标识与“离开网络”也在同一层级，避免在多个折叠区域里寻找当前作用域。

网络与账户页会把状态收敛为“已加入 · 未登录”或“服务在线”等明确标签；登录区域只保留一个下一步，不再重复堆叠网络、账户和服务器说明。暂时忙碌的读取会显示为进行中，技术错误码收在诊断信息中。

在**设置 → Launcher 设置**中可以开启或关闭网络核心的开机自启。该开关读取 dshkerd 的真实注册状态；如果核心暂不可用，会明确提示稍后重试，不会把失败误显示成“未安装”。

即使协调服务尚未就绪或正在读取配置，本机设备名称、设备标识和登录/注册入口仍会保留；服务未就绪时认证控件会置灰，并明确说明原因。

旁边的 **SSH 连接** 页采用一致的紧凑布局：已保存电脑和连接测试优先展示，点击 **添加电脑** 打开弹窗，不会在列表下方展开表单。该页只处理 SSH 连接；加入网络、完整的**我的网络**身份、登记状态、离开网络和设备信息统一放在**网络与账户**页，避免连接操作与账户管理混在一起。

加入同一网络的设备会出现在该网络的电脑列表中；默认局域网成员可以直接进入连接流程，无需在账号页重复确认配对。需要跨网络授权时仍使用对应的安全授权流程。

设备列表就是该网络的成员名单：每台电脑显示在线状态、最后在线时间与上报版本。**移除**会把设备移出该网络并带走它在其中的配对——解绑只影响该网络，设备仍保留自身身份、随时可以重新登记；**撤销**只结束某一条配对，设备留在原地。你选过的网络会按账号记住；本机已不在当前网络时，列表会明确说明原因。

**双机验收已完成。** 两台机器之间的真实会话——在一台 Mac 上经 P2P 通道驱动 Windows 主机上的 DSH Web 运行时（使用线上协调服务器）——已完成端到端验证：连接报告了选中的路径，打开了本地网关 URL，并经隧道加载了远端 DSH Web 页面。反复重连已在两个方向上（各自作为发起方与运行时提供方）做过压力测试，每一轮都验证地址保持不变。

已配对的计算机会**自动连接，无需手动操作**：启动时即为每个生效的配对建立连接；连接断开后会自动重试——先立即重试，随后逐步拉长间隔——机器唤醒或网络恢复时也会立刻重试。只有授权失效（撤销配对或删除其所在网络）才会停止尝试。切换标签页不会中断连接：连接属于这对机器，而不属于当前视图。

远程工作台在上述过程中始终保持**同一个地址**。承载对方 DSH Web 的网关属于这台配对关系而不是某一次连接，因此已打开的浏览器标签页可以挺过断线、切网、休眠唤醒，甚至对方 DSH 重启，并自行恢复。没有会话接入时该地址仍会应答，但不转发任何内容，因此不会暴露过期内容。

规划前需了解两条限制：直连无法建立时，连接会回退到你自己部署的服务器作为不透明中继（TURN，只转发端到端加密的报文流），仅当直连与中继都无法建立时才报 `direct_unavailable`；授权目录只限制本应用的目录选择器——工程打开后，对方电脑上 DSH 自身的权限与审批策略仍然管辖一切。

同一个核心进程也能**完全脱离桌面会话运行**，因此只能通过 SSH 访问的机器同样可以作为可用的主机。`dshkerd serve` 会自行发布私有端点并应答整张方法表；`dshkerd dsh start`／`dshkerd dsh stop` 以独立 subject 运行 DSH Web 子进程；`status`、`pair`、`connect`、`proxy`、`service configure` 是应用同名操作的命令行形式，`call` 可调用任意已发布方法并原样输出拒绝码，便于脚本化。应用本身不受影响——没有已登记的无界面核心时才会启动自己的核心子进程，并保有自己的启动 subject。

开启网络核心自启后，Launcher 会通过带认证的本地端点附加到已经运行的无界面核心，不会再启动第二个设备身份。退出或关闭自启会先完成明确的交接；自启仍开启时，后台核心会继续为 SSH-only 主机提供服务。

详见[使用说明](docs/p2p-connections.zh-CN.md)与[实现清单](openspec/changes/add-self-hosted-p2p-dsh-connections/tasks.md)。

## 技术架构

- **单一后台核心，也能无界面运行。** 一个核心进程持有私有通道、根目录登记、凭据与整套点对点协议，因此应用只跑一个后台进程而不是两个。同一个二进制也能在没有桌面会话时充当主机：`dshkerd serve`、`dsh start|stop`、`status`、`pair`、`connect`、`proxy`、`service configure`、`call`。
- **自托管远程工作台。** 通过[你自己托管的协调服务器](https://github.com/ankye/dshker-server)把你的电脑互联：同一网络内的设备自动配对，每台电脑使用隔离的浏览器会话，远端目录与工程通过授权链路浏览。
- **SSH 通路。** 另一条远程通路是 **SSH 隧道**，把 HTTP 与 WebSocket 流量转发到远端 DSH 真实的回环地址与端口。

## 安装

1. 打开[最新 GitHub Release](https://github.com/ankye/dshker/releases/latest)。
2. 下载对应平台的安装包：
   - **macOS Apple Silicon**：名称包含 `mac-arm64.dmg` 的资产
   - **macOS Intel**：名称包含 `mac-x64.dmg` 的资产
   - **Windows x64**：名称包含 `win-x64.exe` 的资产
   - **Windows ARM64**：名称包含 `win-arm64.exe` 的资产
3. 使用 Release 中的 `checksums.txt` 核对安装包，手动安装后启动 **DSHKer Launcher**。

当前 Release 安装包尚未签名。macOS 可能需要在 Finder 中右键选择“打开”，Windows 可能显示 SmartScreen 提示。请只安装来自本仓库、且已核对校验和的资产；应用不会在后台静默替换自己。

如果仓库尚未发布任何 Release，“最新版本”链接会明确没有可用的更新源。[GitHub Actions 打包记录](https://github.com/ankye/dshker/actions/workflows/package.yml)仍作为短期构建和诊断证据，但不是 Launcher 的更新源。

### 只安装无界面的 `dshkerd` 命令行核心

服务器或远程电脑不需要桌面时，可以只安装独立的 Go 核心，不安装 Electron Launcher。必须选择明确的已发布版本；安装脚本会从官方 Release 下载当前系统和架构对应的压缩包，校验 SHA256 与包内清单，确认无误后原子替换命令行文件。它**不会**自动配置协调服务器、复制凭据、建立配对或开启开机启动。

macOS 和 Linux（一键安装）：

下面的 `0.1.65` 只是示例，请替换成已经发布且包含 CLI 资产的准确版本。

```bash
VERSION=0.1.65
curl -fsSL "https://raw.githubusercontent.com/ankye/dshker/v${VERSION}/tools/install-dshkerd.sh" \
  | bash -s -- --version "$VERSION"
```

默认安装到 `~/.local/bin/dshkerd`；也可以通过 `--install-dir /绝对路径` 指定其他当前用户可写目录。需要审计时，先从同一个 `v${VERSION}` tag 下载脚本，再在本地执行。脚本需要 `curl`、`tar` 以及 `shasum` 或 `sha256sum`。

Windows PowerShell：

```powershell
$Version = '0.1.65'
$Script = Join-Path $env:TEMP 'install-dshkerd.ps1'
Invoke-WebRequest "https://raw.githubusercontent.com/ankye/dshker/v$Version/tools/install-dshkerd.ps1" -OutFile $Script
& powershell -ExecutionPolicy Bypass -File $Script -Version $Version
```

Windows 默认安装到 `%LOCALAPPDATA%\DSHKer\bin\dshkerd.exe`。如果希望在任意终端直接执行 `dshkerd`，请显式把该目录加入 `PATH`。安装完成后，先明确配置你的部署参数，再启动并查看无界面主机：

```bash
dshkerd --version
dshkerd service configure --origin https://你的协调服务器 --wss wss://你的协调服务器/ws --stun stun:你的协调服务器:3478 --pinned-key /绝对路径/coordinator-ca.pem
dshkerd serve --state ~/.dshkerd
dshkerd status --state ~/.dshkerd --json
dshkerd autostart enable --state ~/.dshkerd
```

升级时用新的明确版本重复运行安装脚本即可。卸载命令行文件前先停止正在运行的 `dshkerd`，然后只删除安装文件（POSIX 使用 `rm -f ~/.local/bin/dshkerd`，PowerShell 使用 `Remove-Item "$env:LOCALAPPDATA\DSHKer\bin\dshkerd.exe"`）；安装器不会删除独立的 `~/.dshkerd` 状态目录。服务、信任、配对、连接和 DSH Web 操作是分开的显式步骤。`pair`、`connect`、`dsh start|stop` 和 `proxy` 的方式见 `dshkerd --help` 与[无界面核心说明](docs/p2p-connections.zh-CN.md)；缺少必要值时会明确拒绝，不会猜测或静默走其他路径。

## 检查 Launcher 更新

打开**设置 → Launcher 设置 → 版本更新**可检查固定的 DSHKer GitHub Release 源。Launcher 启动后也会在后台检查，不阻塞主窗口；仅当 GitHub 返回更高的稳定语义版本时才显示启动提示。网络或更新源失败不会在启动时弹窗打扰，可在设置页查看失败状态并主动重试。

发现新版本后，点击**下载**会在 Launcher 内显示下载进度，并把与当前平台严格匹配的 macOS arm64 或 Windows x64 安装包保存到系统“下载”目录。资产缺失、重复或平台不受支持时会明确报错，不会改选其他文件。由于当前 macOS 与 Windows 安装包尚未签名，下载完成后仍需退出 Launcher 并手动运行安装包。Release 更新说明会按 Launcher 当前语言显示。

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
6. **远程连接**：登记、测试、连接并监控可信 DSHKer 电脑的仅回环 SSH 隧道。
7. **浏览器**：使用本地页签，并按需打开远程电脑页签来访问 DSH Web 会话。

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

`package.json` 是 Launcher 版本号的唯一来源。`npm run dist:*` 脚本分别生成 macOS arm64/x64 与 Windows x64/arm64 的本机未签名安装包。`npm run build:dshkerd` 生成六个目标的独立命令行压缩包与清单，也可以使用对应的 `npm run build:dshkerd:*` 单目标脚本。稳定版 `v*` tag 必须与 `v${package.json.version}` 完全一致；桌面端和 CLI 目标全部构建通过并核验清单、校验和后，GitHub Actions 会创建同时包含两条产品渠道的公开 latest Release。手动触发工作流只上传 Actions Artifact，不会发布 Release。

详细交付流程见 [docs/release.md](docs/release.md)，CI 规则见 [docs/ci.md](docs/ci.md)。

## 开源地址

- [DSHKer Launcher](https://github.com/ankye/dshker)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
