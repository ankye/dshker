# 开机自启状态错误投影（2026-09-20）

## 现象

设置页提示“无法读取开机自启状态”，但 dshkerd 的 `core.autostart_status` 已正常注册。

## 根因

主进程跨 IPC 返回统一的扁平 `ApiResult`：失败字段是 `code` 和 `message`。`SettingsPanel.vue` 却读取不存在的 `error.message`，因此任何真实的核心拒绝都会被覆盖为通用文案。

## 修复

- 按扁平结果契约解析 `message`。
- 对 `p2p.autostart_unavailable` 与 `p2p.autostart_unsupported` 使用本地化文案；未知拒绝仍保持通用失败提示，不展示原始技术码。
- 失败时提供一次显式“重新读取状态”操作；不在后台无限重试，也不把拒绝猜测成“未安装”。
- 增加真实失败形状的渲染回归测试，并验证失败时开关保持禁用。

## 验证

`npm test -- --run src/app/shell/tests/settingsAutostart.test.ts`：7 项通过。
