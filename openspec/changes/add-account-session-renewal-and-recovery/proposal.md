## Why

Launcher 用户的登录固定一天到期，忘记密码后也没有原账号恢复入口。用户要求自动续期和重设密码，同时保留账号、设备、网络和配对。

## What Changes

- 使用服务端定义的 30 天登录空闲期限，在启动恢复及后台维护时续期，不保存密码。
- 增加管理员签发的 15 分钟一次性重设码，以及受限 Launcher 重设密码表单和命名 IPC。
- 重设只修改原账号密码并撤销其登录会话，保留设备、网络和配对。
- 不增加邮件服务、替代账号、过期认证绕过或旧服务器兜底。

## Capabilities

### New Capabilities
- `account-session-recovery`: 桌面会话续期、原账号密码重设和安全恢复。

### Modified Capabilities
无。

## Impact

Launcher 的 Go HTTPS/helper、Electron 账户 owner 和受限 IPC、Vue 登录页、双语字典、测试和文档。独立 `dshker-server` 由 Go workspace 的同名 OpenSpec 定义 HTTP、数据库和管理员 CLI；DeepSeek Harness 无需改动。当前生产账号和部署不在本次源码实现中被直接改写。
