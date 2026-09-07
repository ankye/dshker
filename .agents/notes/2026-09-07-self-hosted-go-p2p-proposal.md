# 自建 Go 协调服务与 DSHKer 点对点连接提案

## Scope

- OpenSpec change: `add-self-hosted-p2p-dsh-connections`。
- 用户明确 ZeroTierOne 仅作原理参考；目标是自研 Go 服务器、DSHKer 客户端，不引入 ZeroTier/libzt 依赖。
- 本轮仅写规划产物，不实现生产代码、不部署服务器、不修改 ZeroTier checkout，也不发布新版本。

## Decisions

- Go 服务负责设备登记、配对、在线状态、信令与 STUN；DSHKer 内置 Go peer 采用 Pion ICE/DTLS/DataChannel 直传受管 DSH HTTP/WS。
- 服务与 peer 独立构建；Electron main 保留受管进程、凭证和网络权限，renderer 只使用命名能力。
- 沿用实际运行 URL 的动态端口、独立测试结果、红绿连接状态、Local 与每台电脑固定标签。保持既有 SSH 模式，不自动迁移或切换。
- 配对只交换公钥及授权，设备私钥留在本机；DSH Token 仅在认证直连中使用，不经过协调服务。
- 无 TURN/业务中继/公开服务兜底；打洞失败明确报告。Windows↔macOS 验收必须使用不同物理设备，本机自连不算跨平台证据。

## Approved remote UI and editing revision

- 用户确认补齐远程 Tab 操作界面及 SSH/P2P 修改功能：服务配置、本机登记、配对申请、测试、连接/断开、编辑、撤销与移除。
- 名称单独修改保持当前连接和固定 tab；连接参数修改要求相关电脑先断开，共享服务编辑显式列出全部影响对象。成功保存后旧测试失效，不自动重连。
- 编辑保持记录身份、原 catalog 格式和原子持久化；校验/并发冲突/写入失败保留草稿和原配置。身份变更走重新登记/配对，新服务 origin 验证前不得接收旧凭据。
- Run 断线页增加原记录连接/重试/编辑入口；撤销成功但本地移除失败保持 revoked，不恢复授权。
- 按用户追加要求补齐测试用例：62 条规格场景各有一条精确追踪用例，另有 15 条边界/故障/旧功能回归用例，共 77 条基础用例；参数和平台展开各自记结果。
- 交互设计约束使保存反馈、焦点、草稿/秘密保留边界与迟到结果有明确行为；质量约束要求 UI/API/持久读回、实际网络路径、身份键及原始证据，而非只检查 200 或最终截图。
- 本轮仍为规划更新；所有用例 NOT_RUN，未编写或执行生产实现及自动化用例，未创建空 test-gates 清单充当测试通过。

## Artifacts

- `proposal.md`: 目标、范围与两项新 capability。
- `design.md`: Go 模块、部署、身份、协议、DSH 桥接、生命周期、安全边界和验收设计。
- `specs/self-hosted-peer-coordination/spec.md` 与 `specs/direct-peer-dsh-sessions/spec.md`: 规范需求及正反场景。
- `tasks.md`: 带 owner、依赖和验证方式的未执行任务清单。

## Validation

- `openspec validate add-self-hosted-p2p-dsh-connections --strict`：通过。
- `npx --no-install prettier --ignore-path /dev/null --check openspec/changes/add-self-hosted-p2p-dsh-connections .agents/notes/2026-09-07-self-hosted-go-p2p-proposal.md`：通过。显式覆盖仓库对 `openspec/` 的格式忽略规则，实际检查新文档。
- `openspec status`：四项规划产物完成；`openspec list --json`：实现任务 0/39，未将规划完成计为实现完成。
- 只读 Node 追踪检查：62/62 个 Scenario 一一对应 C/D 用例，15 个 X 补充用例；77 个用例 ID 无重复/断号；39 个实现任务均包含 owner、依赖及验证方式。此检查只验证目录完整性，不代表执行通过。
- ZeroTierOne checkout 保持 clean；DSHKer 仅新增本提案目录及此 Agent Note。
- 本轮没有运行代码/原生打包/跨机器测试；这些属于任务清单中的后续实现与验收，不由文档检查代替。

## Pending deployment inputs

公网服务地址/域名、Linux 架构、TLS 证书来源及部署凭证需在部署前明确提供；未猜测或提交真实凭证。
