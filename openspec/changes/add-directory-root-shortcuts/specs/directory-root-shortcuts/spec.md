## Purpose

让 DSHKer 启动的 DSH 页面内目录选择器在任意层级都能直接到达当前层级无法通过向上导航到达的磁盘与挂载卷，同时保持目录列表、新建文件夹、错误语义和宿主文件系统权限完全由 Harness 的 browse 后端负责。

## ADDED Requirements

### Requirement: Every listing offers the roots the level cannot reach by walking

页面内目录选择器 SHALL 在每一层目录列表前提供当前层走不到的根：Windows 上为其它盘符，POSIX 上为当前层之外的挂载卷。当前层等于该根、该根是当前层祖先（向上导航已可达）、或该根是当前层后代（当前层已将它列为子项）时 SHALL 不提供该根。SHALL NOT 复制已在 `entries` 中出现的路径。

#### Scenario: Choose another disk on Windows

- **WHEN** 宿主 home 在 `C:` 上，用户在页面内选择器打开 home
- **THEN** 列表顶部出现 `D:`、`E:` 等其它可访问盘符行，且不出现 home 所在盘符（它是 home 的祖先）

#### Scenario: Choose a mounted volume on macOS

- **WHEN** 用户打开 home，且 `/Volumes/CodeS` 与 `/Volumes/Macintosh HD`（解析为 `/`）已挂载
- **THEN** 列表顶部出现名称为 `CodeS` 的行，指向 `/Volumes/CodeS`；解析为 `/` 的卷不重复出现

#### Scenario: Return to the home drive

- **WHEN** 用户在另一块磁盘的 `work` 目录浏览
- **THEN** 列表顶部出现 home 所在盘符，选择后列出该磁盘的根目录

#### Scenario: Volume parent already lists its volumes

- **WHEN** 当前层是 `/Volumes`
- **THEN** 不追加任何卷捷径行，因为当前层已经把卷列成子项

### Requirement: Root shortcuts resolve through the same browse backend

根捷径 SHALL 是宿主上的真实绝对路径，SHALL 由同一 browse 后端列出其内容；Launcher SHALL NOT 为捷径单独实现目录读取、新建文件夹或错误码。选择捷径行后 SHALL 保持 Harness 的路径校验、隐藏条目标记、结果上限与失败业务码。

#### Scenario: Browse into a shortcut

- **WHEN** 用户选择另一块磁盘的盘符行
- **THEN** 目录内容由 Harness browse 后端列出，返回的 `path` 为该磁盘的根路径，面包屑列出该层的真实祖先

#### Scenario: Shortcut target disappears

- **WHEN** 捷径指向的卷在列出前被卸载
- **THEN** 该次列出按 Harness 的业务码失败并显示其错误，Launcher 不替换为其它目录或本机路径

### Requirement: Root discovery never degrades the picker

根枚举 SHALL 在探测失败、超时、卷不可读或调用已取消时保持原列表不变；SHALL NOT 因根枚举失败而拒绝列出、延迟超过探测上限或改写 Harness 返回的错误。探测 SHALL 有单项超时与短期缓存，SHALL NOT 在每次导航重复探测全部盘符。

#### Scenario: Unresponsive drive letter

- **WHEN** 某个盘符对应的设备无响应
- **THEN** 该盘符不出现在捷径中，其余列表在探测上限内正常返回

#### Scenario: Root enumeration fails

- **WHEN** 卷父目录不可读
- **THEN** 用户看到的就是 Harness 后端返回的原列表，没有新增行也没有新增错误

### Requirement: The plugin ships with the application and mutates nothing outside it

该扩展 SHALL 以 Launcher 自有资源随应用发布，由 overlay 以相对文件名插入并按 overlay 所在目录解析；SHALL NOT 写入 `~/.dsh`、SHALL NOT 修改选中的 Harness checkout、SHALL NOT 通过 `dsh plugin add` 进入用户 profile、SHALL NOT 新增 renderer 权限或 IPC 操作。打包后 SHALL 保持 overlay 与插件文件的同目录几何。

#### Scenario: Installed application starts DSH

- **WHEN** 已安装的 Launcher 启动受管 DSH Web
- **THEN** overlay 与插件都从应用资源目录解析，用户 profile、`~/.dsh` 与 Harness checkout 前后无变化

#### Scenario: Harness version switch

- **WHEN** 用户切换到另一个已安装的 Harness 版本并重启 DSH
- **THEN** 同一 overlay 继续生效，不需要为任何版本重装插件或改动 checkout
