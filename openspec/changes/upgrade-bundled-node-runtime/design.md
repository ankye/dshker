# Bundled Node 24 upgrade — design

版本身份是打包门禁：Node 版本与归档 SHA-256 pin 在源码中，`runtime:prepare`、
`runtime:verify`、`resolvePnpmLauncher` 与 `release:smoke` 都以它为准。因此这次升级
是"换 pin"，不是引入版本协商。

- 选择 24.22.3 的理由：DSH 0.2.2-rc 要求 `>=24.9.0`；24.22.3 是 v24 线官方当前最新
  （2026-11-11 发布），与本机已装的系统 24.22.1 同线，避免跨大版本行为差异。
- 校验和来源：`https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt`，逐项核对六个
  平台归档与 headers 归档，未做任何推断或复用旧值。
- 旧 22.23.3 stage 的描述符不再匹配 `resolvePnpmLauncher` 的 pin，按既有规则明确拒
  绝并提示重跑 `runtime:prepare`，不做就地静默升级。
