## 1. Protocol and ownership
- [x] 1.1 定义与独立 server 一致的续期、一次性恢复和身份保留契约。
- [x] 1.2 实现 Go HTTPS/helper 续期与重设操作，验证 admission、scope、持久读回和撤销竞态。

## 2. Desktop implementation
- [x] 2.1 主进程启动与定时续期只采用 canonical 服务端期限，验证并发、重启、临时失败和登出。
- [x] 2.2 添加严格命名 resetPassword IPC、preload 契约和 admission 测试。
- [x] 2.3 添加双语重设表单和 domain，验证确认、secret 清理、stale 与不确定结果。

## 3. Verification and handoff
- [x] 3.1 独立真实 server 与核心验证续期/重启/重设/原身份保持。
- [x] 3.2 更新 CHANGELOG、两份 README、Agent Note 和测试证据清单。
- [ ] 3.3 执行项目检查、build、源码大小和独立审查，记录实机与部署边界。

源码检查与独立功能链路通过；完整互动 default verify 因缺原始 frame/timing ledger 失败，3.3 不据此提前完成。未进行生产部署或改写当前账号。

## 4. 后续单账号维护授权

- [x] 4.1 用户明确授权后，保留线上原二进制/schema7，备份并受控重设指定原账号密码；可信 HTTPS 登录、原身份及网络/设备/配对读回通过，验证会话 logout 且原服务 active。此步骤不代表新版协议部署或完整发布验收。
