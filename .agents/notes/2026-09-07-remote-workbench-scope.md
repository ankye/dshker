# 完整远程工作台范围与发布授权

- 用户确认更新后完整实现并发布，显式使用 quality-engineering；所属现有变更 `add-self-hosted-p2p-dsh-connections`，没有重复创建提案。
- 已更新 proposal、design、两个 delta specs、tasks：授权根与远端目录选择、真实 DSH 工程/会话/文件/任务、结果未知与断线恢复、完整发布条件。
- 纠正原“远程文件接口全部不做”与现需求的冲突：开放有限的命名工程选择，继续禁止通用文件/shell 代理、任意网络转发、SSH/TURN 自动兜底及文件同步。选择器授权不冒称 DSH Agent 沙箱。
- 新增实现任务 1.4、4.5–4.8、5.10、7.8–7.9；新增工作台场景 D48–D61，并补齐此前网络操作漏项 D62/D63。均未勾选，不用文档完整性冒充实现。
- 当前阶段仅改规划文档，没有改生产代码、提交、推送或发布。openspec-update-change 限定本阶段只更新规划；后续实现阶段使用 openspec-apply-change，用户的实施/发布授权已记录，不需要重新讨论已确认范围。
- OpenSpec strict validation 通过；source-file-size 检查当前工作树 49 个代码文件、0 个超限。
- 默认 test-integrity verify 仍失败：现有 Go-only 清单未覆盖完整工作树中的 Electron/SSH/UI/日志改动。完整 interactive manifest、实现前置证明、真实 App 工作台 ledger、四平台/跨机/完整包证明仍未齐，当前 release verdict 为 not ready。
- 质量要求包含真实文件/任务独立读回、至少 1 小时真实 DSH 会话、多 peer/多流及慢读恢复、无重复执行、全部源码 <=1000 物理行、生产 mock 零可达及最终包检查。现有 90 秒 Go 双进程结果仅是诊断层。
