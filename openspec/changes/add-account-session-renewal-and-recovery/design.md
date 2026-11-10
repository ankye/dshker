## Context

动机见 proposal.md。Go 核心与 Electron 当前共享 native secret key `peer-user-session:<serviceId>`。现有 user.current 只返回公开用户身份；不能向普通 renderer 暴露 token 或通用凭据能力。

## Goals / Non-Goals

目标：自动维持已登录 Launcher、提供显式原账号恢复；不重建身份。
非目标：邮件投递、已过期 token 复活、自动创建账号、修改 Harness、发布或改写生产密码。

## Decisions

- 新 `POST /v1/session/renew` 使用原 bearer，返回现有 `{user,token,expiresAt}`。服务端延长至至少 now+30 天，token 不轮换：丢失回复后仍可使用原 token 查询并再次续期；过期、登出、禁用或重设后不存在的会话不能恢复。
- 新 main-only `user.renew` RPC 序列化原 session scope，校验返回 token/用户并先保存读回 canonical。Electron 只接受返回期限，不把捕获的旧期限重新写回。启动采用持久 token 时调用；运行中在维护 sweep 及账户操作时仅在剩余七天内续期；每服务合并并发，close/logout/change scope 拒绝迟到响应。
- 普通 user.current 返回形状保持不变。旧服务器不支持续期时返回明确错误，保留已有记录，不猜期限、不换接口。
- 重设已获服务器确认但 native 删除失败时，保留明确的 cleanup 错误并撤销原本地 owner。只有新的 `user.renew` 入场在 exact token/canonical record 对应明确 revoked owner 时返回 `p2p.user_login_required`，允许主进程显式重试清理；其他 scope 失配、HTTP 进行中注销和服务故障仍保留原错误。清理失败不隐藏、不重放 reset code；清理恢复后必须用新密码重新向服务器认证，不能恢复旧 token。
- 新命名 `resetPassword` IPC 仅接收 serviceId/email/code/password，结果 void；不暴露重设码签发、shell 或 credential 通用能力。通过激活的已钉扎服务访问 `POST /v1/password/reset`。重设不要求旧登录，成功清除当前原账号的登录投影且让用户手动用新密码登录，不自动重试提交。服务端统一 `p2p.password_reset_invalid`，UI 显示明确无效/过期提示。
- 重设表单和注册/登录互斥，重设码及密码仅存在局部输入，提交/切换时清空；重设请求不进入 operation draft、持久设置或日志。中文/英文文案来自 typed dictionaries。

## Risks / Trade-offs

- 稳定 bearer 可在活跃使用中长期维持权限 → 只在 TLS、OS protected storage 内传递，密码重设撤销该账号所有 session，任何已撤销 token 均不能续期。
- 断网超过 30 天 → 明确要求重新登录；旧的 24 小时会话已失效时不能迁移为授权。
- 重设回复丢失 → 不重提，提示使用新密码登录核对；原设备、网络、配对不被清除。
- 服务器已确认重设，但本机保护存储删除失败 → 明确返回清理失败，main 撤销匹配的内存登录；仅续期入口将精确原记录对应的已撤销本地 owner 表达为 login_required，后续显式登录先重试清理。清理仍失败时原样报错，不重放重设码，也不将普通 scope_mismatch 当作未登录。

## Migration Plan

先部署服务端 schema 与新端点，再分发 Launcher；现有未过期会话可显式续期，过期会话需登录或管理员重设码。服务端回滚不应降级已迁移数据库；部署、当前用户实机改密和发布验收单独记录。
