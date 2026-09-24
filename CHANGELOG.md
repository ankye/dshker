# Changelog

## 0.1.80 — 2026-09-24

### 简体中文 (zh-CN)

- **挂机时不再持续空转。** DSH 启动后，外壳每 200 毫秒就向核心请求一次控制台和状态，每秒十次，不管有没有输出、窗口是否在前台——启动阶段有用，之后几小时里全是空读。现在有输出时保持 200 毫秒的灵敏度，连续多次读到空才逐步放慢到 2 秒；一有新输出立刻恢复。实测 12 秒静默从 60 次请求降到 12 次。
- **窗口看不见时不再读取运行状态。** 界面每 1.5 秒轮询一次启动状态，最小化或切到别处时照旧唤醒主进程和核心。现在隐藏时暂停，重新可见时立即读一次，不等下一个周期。

说明：活动监视器里占用最高的那个渲染进程是嵌入的 DSH 页面本身（流式输出与代码高亮），不是 Launcher 的逻辑；本次优化针对的是外壳这侧确实在空转的部分。

### English (en-US)

- **An idle launch no longer keeps polling at full speed.** Once DSH was up, the shell asked the core for its console and status every 200ms — ten times a second, regardless of whether anything had been written or the window was even in front. That rate is right while a launch is starting and pure waste for the hours after. It now holds 200ms while output is arriving, slows toward 2s only after a sustained run of empty reads, and returns to full speed on the next line. Measured over twelve seconds of silence: 12 reads instead of 60.
- **A hidden window no longer reads launch state.** The interface polled every 1.5s even when minimised or behind another app, waking both the main process and the core to render nothing. It now pauses while hidden and reads once immediately on becoming visible, rather than waiting for the next tick.

Note: the heaviest renderer in Activity Monitor is the embedded DSH page itself (streaming output and syntax highlighting), not launcher logic. This release addresses the shell-side work that was genuinely spinning.

## 0.1.79 — 2026-09-24

### 简体中文 (zh-CN)

- **浏览器标签页现在固定显示机器名，不再跟着网页标题变。** 之前标签用的是网页自己的标题，所以在某台机器的工作区里点来点去，标签文字就一直改；同时开几台机器时，几个标签会变得互相看不出区别，认不出哪个是哪台。现在标签始终是那台机器的名字，鼠标悬停时才显示当前网页的标题和地址。给机器改名后标签会跟着改，本机标签仍是"本机"。

### English (en-US)

- **Browser tabs now stay labelled by machine instead of following the page title.** A tab took its text from whatever the page called itself, so navigating inside one machine's workspace kept rewriting it, and with several machines open the tabs drifted into labels that no longer told them apart. A tab is now named after its machine; the current page's title and address moved to the tooltip. Renaming a computer still renames its tab, and the local tab keeps its own label.

## 0.1.78 — 2026-09-24

无用户可见的行为变化；这一版让上一版承诺的 CI 验证真正跑起来。

### 简体中文 (zh-CN)

- **两台电脑之间的连接现在真的由 CI 验证了，不再只是配置好而未生效。** 上一版加了这个检查，但它一直处于"跳过并警告"状态，因为缺少读取协调器仓库的凭据。现在用一个仅对该仓库只读的部署密钥（不是账号令牌，写不了任何东西，也碰不到其他仓库），30 个连接用例每次推送都真实执行。
- **修好三处让 CI 失败、却与产品无关的问题。** 协调器对每个来源每秒只接受有限次请求，而一次连接会花掉好几次，所以我新写的两个工作台测试连发尝试时在快机器上被限流——之前只在慢机器上偶然通过。Linux 的密钥存储依赖 libsecret，CI 机器没有，现在装上并起一个解锁的钥匙环，而不是把这些用例排除掉。自动启动只在 macOS 和 Windows 实现，相关用例现在自己说明这一点并跳过，而不是靠 CI 的排除名单——那会让平台限制和真实回归看起来一样。

### English (en-US)

No user-visible behaviour changes; this release makes the CI verification the previous one promised actually run.

- **The connection between two computers is now genuinely verified by CI, rather than configured and inert.** The previous release added the check but left it skipping with a warning, because it had no credential for the coordinator repository. It now uses a deploy key that is read-only for that one repository — not an account token, unable to write anything or reach anything else — and thirty connection cases run on every push.
- **Three CI failures that said nothing about the product are fixed.** The coordinator admits a bounded number of requests per second per source and one connect spends several, so the two new workbench tests tripped it on a fast runner while passing locally by accident of timing. The Linux credential store needs libsecret, which the runner lacked; it is now installed with an unlocked keyring instead of excluding those cases. Autostart exists on macOS and Windows only, and that case now says so itself and skips, rather than living in a CI exclusion list where a platform limit and a real regression look alike.

## 0.1.77 — 2026-09-23

无用户可见的行为变化；这一版只加强发布前的验证。

### 简体中文 (zh-CN)

- **两台电脑之间的连接现在由 CI 验证。** 此前这套测试只能手工运行，结果是连着三个缺陷先发布、后才被发现：流层拒绝没有工作台的连接、守护进程在该路径上崩溃、丢掉工作台导致整条连接被判失败。每一个都是我在本地跑出来的，都在承载它的版本发布之后——代价是你在两台机器上反复安装。现在 30 个用例每次推送都跑（另外 2 个需要真实 Harness 的仍留在本地）。
- **发布产物检查改为按 release 编号查询，并要求每个安装包真的上传完成。** 按 tag 查询会读到 GitHub 的缓存，同一个挂了 25 个安装包的 release 可能被报成 0 个，那会让这道闸门既漏掉真故障、又凭空造出假故障。另外 GitHub 在上传刚开始时就会登记资产名，所以半途失败会留下一个名字却没有内容——只数名字看不出来，现在要求状态为 `uploaded`。检查清单也补上了 Linux 的三个产物，之前写错了架构名。

### English (en-US)

No user-visible behaviour changes; this release only strengthens pre-release verification.

- **The connection between two computers is now verified by CI.** This suite could only be run by hand, which is how three defects shipped in a row and were found afterwards: the stream layer refusing a connection with no workbench, the daemon segfaulting on that path, and a lost workbench condemning an otherwise healthy link. Each was found locally, after the release that carried it — paid for in repeated installs on two machines. Thirty cases now run on every push; the two that drive a real Harness remain local.
- **The release asset gate reads by release id and requires each installer to have finished uploading.** Reading by tag returns a cached representation that has reported zero assets for a release holding twenty-five, which would make the gate both miss a real failure and invent one. GitHub also records an asset name the moment an upload begins, so a transfer that died halfway leaves a name with nothing behind it — invisible to a check that counts names, so `uploaded` state is now required. The checklist also gained the three Linux artifacts, whose architecture names it had wrong.

## 0.1.76 — 2026-09-23

### 简体中文 (zh-CN)

- **修复曾经有工作台的电脑，工作台坏掉后整条连接失败。** 之前有工作台、后来 DSH 坏掉重连时，系统仍然公布那个已经不服务任何东西的地址，随后对它的健康检查失败，把一条本来正常的连接判为失败（`p2p.runtime_http_failed`）。结果很荒谬：从没有过工作台的电脑能连上，而丢掉自己工作台的那台连不上。现在地址只在这次连接真的带着工作台时才公布。
- **发布流程不会再产出装不了的版本。** 上一个 tag 构建全部成功、release 也建好了，但安装包一个都没上传，而流程认为成功——你只有去装的时候才会发现。现在会核对 release 上实际挂了哪些安装包，缺少就让构建失败。
- **协调服务器同步更新。** 服务器和客户端各有一份协议解码器，靠人工同步；这次把服务器上中继客户端数据的那部分也放宽，否则客户端将来加字段又会被服务器拒收，表现成"新客户端连不上"。服务器自己的 HTTP 接口仍然严格。已部署到线上。
- **两台电脑之间的通信协议现在可以演进了。** 此前任何一方多发一个字段，另一方都会整条消息拒收，所以协议一旦定型就再也不能加东西——这正是为什么一个修复只装了一台机器时完全不生效，而且两端日志各说各话。现在不认识的字段会被忽略。
- **握手加入能力声明，一次加好、以后不必再改结构。** 用名称列表而非逐个功能加字段。第一个能力是"没有工作台也维持连接"：对方是旧版时，日志直接说明"本端保持连接，但对方的版本会主动断开，请升级"。
- **区分两类消息各用各自的严格程度。** 跨机器的对等消息容忍未知字段（两端独立升级）；本机内部通道和自家服务器响应保持严格（出现未知字段说明契约漂移，应尽早暴露）。
- **测试覆盖工作台的全部五种结局。** 一次运行覆盖：拒绝、恢复、恢复后再次丢失、返回不可用地址、二次恢复。每一项都对应一个已经发布出去的缺陷——上面第一条就是这个测试发现的。

### English (en-US)

- **Fix a computer that had a workbench failing its whole connection once that workbench died.** After having one, a pair that reconnected still published an address that no longer served anything; the health check against it then failed and condemned an otherwise healthy connection as `p2p.runtime_http_failed`. The result was backwards: a computer that never had a workbench could connect, while one that lost its own could not. An address is now published only when the attempt genuinely carries a workbench.
- **The release pipeline can no longer ship a version nobody can install.** The previous tag built successfully and created its release, yet uploaded zero installers while reporting success — discoverable only by trying to install it. The pipeline now checks which installers the release actually holds and fails when they are missing.
- **The coordinator is updated to match.** Server and client each carry their own copy of the protocol decoder, kept in sync by hand; the server half that parses relayed client traffic is now tolerant too, otherwise a client that adds a field would be rejected there and surface as "the new client cannot connect". The server's own HTTP API stays strict. Deployed.
- **The protocol between two computers can now evolve.** Any field one side added was enough for the other to reject the entire message, so the contract was frozen the moment it shipped — which is why a fix installed on one machine had no effect until the other was upgraded, each side's log blaming something different. Unknown fields are now ignored.
- **The handshake advertises capabilities, designed once so the structure never changes again.** A list of names rather than a field per feature. The first is "keeps a connection with no workbench": against an older peer the log now says plainly that this side keeps the link while the peer's build will close it and should be upgraded.
- **Two classes of message, each with the strictness it needs.** Cross-machine peer messages tolerate unknown fields because the ends upgrade independently; this process's private channel and our coordinator's responses still refuse them, because there an unknown field means drift and must be loud.
- **Test coverage for all five workbench outcomes.** One run covers refusal, recovery, loss after recovery, an unusable address, and a second recovery. Every row is a defect that already shipped — the first entry above is one this test found.

## 0.1.75 — 2026-09-23

### 简体中文 (zh-CN)

- **两台电脑之间的通信协议现在可以演进了。** 此前任何一方多发一个字段，另一方都会整条消息拒收，所以协议一旦定型就再也不能加东西——这正是为什么一个修复只装了一台机器时完全不生效，而且两端日志各说各话、谁都说不清原因。现在不认识的字段会被忽略，以后新增可选字段不会让旧版本断连。
- **握手加入能力声明，一次加好、以后不必再改结构。** 用的是名称列表而不是逐个功能加字段，所以后续新增能力只是多一个名字。第一个能力是"没有工作台也维持连接"：当对方是不支持它的旧版本时，日志会直接说明"本端保持连接，但对方的版本会主动断开，请升级"，而不是留下两份互相矛盾的日志。
- **区分两类消息，各用各自合适的严格程度。** 跨机器的对等消息（握手、数据帧、信令、目录）容忍未知字段，因为两端各自独立升级；本机内部通道和自家协调服务器的响应保持严格拒收，因为那里出现不认识的字段说明契约漂移了，尽早发现比容忍更有价值。顺带：数据帧走的是较快的那条解析路径。

### English (en-US)

- **The protocol between two computers can now evolve.** Any field one side added was enough for the other to reject the entire message, so the contract was frozen the moment it shipped — which is exactly why a fix installed on one machine had no effect until the other was upgraded, with each side's log blaming something different and neither able to say why. Unknown fields are now ignored, so adding an optional field no longer disconnects older builds.
- **The handshake advertises capabilities, designed once so the structure never has to change again.** It carries a list of names rather than a field per feature, so a later capability is just another name. The first one is "keeps a connection with no workbench": when the peer is an older build without it, the log now says plainly that this side keeps the link but the peer's build will close it and should be upgraded, instead of leaving two logs that contradict each other.
- **Two classes of message, each with the strictness it needs.** Cross-machine peer messages (handshake, data frames, signalling, directory) tolerate unknown fields because the two ends upgrade independently; this process's own private channel and our coordinator's responses still refuse them, because there an unrecognized field means the contract drifted and finding it immediately is worth more. Incidentally, data frames now take the faster of the two paths.

## 0.1.75 — 2026-09-23

### 简体中文 (zh-CN)

- **修复工作台挂掉后，原来的地址还能打开却什么都打不开。** 某台电脑之前连接正常、有工作台（地址稳定，标签页可能正开着），之后它的 DSH 挂掉重连时，那个地址仍然指向已经结束的旧会话：界面显示"已就绪"、地址看起来正常，但每个请求都失败——这比直接连不上更难判断。现在这种情况下地址会明确报"正在重连"，而不是假装可用。
- **补上工作台恢复后的验证。** 新增测试覆盖用户真正会走的顺序——DSH 坏了、修好、标签页应该能用：先在对方没有工作台时连上，再确认工作台恢复后被自动挂上，且那个地址真的能通到对方。

### English (en-US)

- **Fix a workbench address that stayed openable but served nothing after the workbench died.** A computer that had connected successfully and had a workbench (a stable address, possibly with a tab open on it) kept pointing that address at a session that had already ended once its DSH died and the pair reconnected: the interface said ready and the address looked fine while every request through it failed — harder to diagnose than not connecting at all. Such an address now reports that it is reconnecting instead of pretending to work.
- **Cover the workbench recovery path.** A new test follows the sequence users actually hit — DSH broken, fixed, tab expected to work: connect while the peer has no workbench, then confirm a recovered one is attached automatically and that its address genuinely serves the peer.

## 0.1.74 — 2026-09-23

### 简体中文 (zh-CN)

- **修复只要有一端的工作台起不来，两台电脑就完全连不上。** 连接的底层通道此前要求"必须已有一个工作台"才允许建立，所以任意一端的 DSH 起不来，连接在协议层就直接失败——**两个方向同时失败**，因为两端共用同一条通道。这也是为什么发起方自己的 DSH 坏了同样连不上。现在连接的建立与维护完全由 dshkerd 负责，工作台只是连接之上的一项可选内容：没有工作台时连接照样建立、照样保持，只是暂时没有可打开的页面。
- **修复没有工作台时守护进程崩溃。** 一旦走到"连接成立但没有工作台"的分支，两处代码会对不存在的对象取值，导致 dshkerd 段错误退出。
- **修复刚连上就被自己断开、反复重连。** 界面在每次掉线时立即重新发起连接，而发起连接本身会顶掉该配对已有的连接——于是每次重连都制造出下一次掉线。日志显示连接达到"就绪"后约半秒被拆除，如此循环不止，其间的重试还会因为本机信令尚未重建而被拒绝。掉线现在交给核心已有的重连节奏（1 秒、2 秒、5 秒、15 秒、60 秒）。
- **区分"本机信令尚未就绪"与"协调服务器不可达"。** 前者此前复用了后者的提示，让人去检查从未出问题的网络与服务器。
- **补上一直缺失的测试。** 此前所有连接测试都给一个"永远能成功启动"的假工作台，因此上述三个缺陷在测试中完全不可见——而它们正是真机上"一开 tab 就连不上"的原因。新增的测试让对端像真实机器一样拒绝提供工作台。

### English (en-US)

- **Fix two computers being unable to connect at all whenever either side's workbench could not start.** The connection's own stream layer required a workbench to already exist before it would open, so a machine whose DSH could not run failed the connection at the protocol level — in **both directions at once**, because the two sides share that one layer. This is also why the initiator's own broken DSH prevented connecting. Establishing and maintaining a connection is now entirely dshkerd's job, and a workbench is one optional thing carried over it: without one the connection is still established and still maintained, with no page to open for the moment.
- **Fix the daemon crashing when there is no workbench.** Two places dereferenced an object that does not exist in that case, taking dshkerd down with a segfault the moment such a connection was established.
- **Fix a connection tearing itself down right after it came up, forever.** The interface re-dispatched a connect on every drop, and dispatching one supersedes the pair's existing connection — so each retry produced the next drop. The logs show a connection reaching ready and being torn down about half a second later, on repeat, with the retry in between refused because this machine's signalling had not finished rebuilding. A drop is now left to the core's existing schedule (1s, 2s, 5s, 15s, 60s).
- **Tell "this machine's signalling is not ready" apart from "the coordinator is unreachable".** The former reused the latter's message, which sent users to inspect a network and a server that were never at fault.
- **Add the test that was missing all along.** Every existing connection test handed out a stub workbench that always starts, which made all three defects above invisible — and those defects are exactly why opening a tab failed on real machines. The new test refuses a workbench the way a real machine does.

## 0.1.73 — 2026-09-23

### 简体中文 (zh-CN)

- **修复 pnpm 的启动脚本与 Node 分开存放时被判定为没安装。** scoop 就是这种布局：shim 和 pnpm 的入口脚本放在 `persist` 下，而 `node.exe` 在带版本号的目录里、通过一个链接对外暴露。此前只查那个链接，而从桌面启动的进程未必能跟随它，于是 `node.exe` 看起来不存在、一个完全可用的 pnpm 被丢弃、报告"没有安装 pnpm"——对方连过来时所需的 DSH 启动因此被拒，最终显示为"连不上协调服务器"。现在直接查带版本号的目录，不再依赖那个链接。
- **记录每一次连接的完整过程，而不只是失败。** 之前每个阶段的转换都是静默的，只有少数几个失败分支会输出，所以一次没能连上的尝试留不下任何痕迹：对方从未可达、直连从未建立、对方拒绝启动工作台——三种情况共用同一份空日志。现在连接请求、协调器的授权结果、收到的入站尝试、每一次阶段转换（打洞、启动运行时、就绪、断开、失败）以及失败对应的原始错误都会记录下来。

### English (en-US)

- **Fix pnpm being reported as missing when its entry script is kept apart from Node.** Scoop uses exactly this layout: the shim and pnpm's entry script live under `persist`, while `node.exe` sits in a versioned directory exposed through a link. Only that link was searched, and a desktop-launched process cannot always follow it, so `node.exe` appeared to be absent, a working pnpm was discarded, and the launcher reported none installed — which refused the DSH launch an inbound connection needs and surfaced as "cannot reach the coordinator". The versioned directories are now searched directly, without depending on the link.
- **Record the whole life of a connection, not only its failures.** Every stage transition was silent and only a few failure branches printed anything, so an attempt that never connected left no trace of how far it got: a peer that was never reachable, a direct path that never formed, and a far side refusing to start its workbench all shared one empty log. A connection request, the coordinator's authorization result, an accepted inbound attempt, every stage transition (punching, starting-runtime, ready, disconnected, failed) and the underlying error behind a failure are now all recorded.

## 0.1.72 — 2026-09-23

### 简体中文 (zh-CN)

- **修复明明装了 pnpm 却报告找不到。** 从桌面启动的应用继承的是登录时那一份环境变量，之后安装任何东西都不会更新它，所以在终端里 `pnpm` 完全正常的机器，在本应用看来却不存在——启动 DSH 因此被拒，对方连过来时连接被关闭并反复重连。现在除了继承到的 PATH，还会读取用户与系统登记的 PATH，并补上 scoop 实际存放 pnpm 的位置。
- **诊断日志保留两端而不是截断尾部。** 一条拒绝把结论写在前面、证据写在最后（"在以下目录中找不到 pnpm：……"），只保留开头恰好丢掉了唯一有用的部分。

### English (en-US)

- **Fix pnpm being reported as missing on a machine that has it.** A desktop-launched application inherits the environment as it stood at sign-in and never sees anything installed afterwards, so a machine where `pnpm` works in every terminal had none as far as this application was concerned. Starting DSH was refused for it, which closed an inbound connection and retried without end. The registered user and machine PATH are now consulted alongside the inherited one, and scoop's real pnpm location is searched.
- **Keep both ends of a long diagnostic line.** A refusal states its conclusion first and its evidence last — "no pnpm was found in: <directories>" — so keeping only the head discarded the one part worth reading.

## 0.1.71 — 2026-09-23

### 简体中文 (zh-CN)

- **修复对方连过来时被拒、并反复重连。** 连接建立后，被连接的那台电脑要为这条连接启动 DSH，而启动请求因为找不到可用的 pnpm 被拒绝，于是连接被关闭、重连、再次失败，循环不止。界面把这个循环显示为"连不上协调服务器"，指向了完全无关的地方——协调器一直是通的。
- **修复 pnpm 查找被一个无法解析的候选中断。** Windows 上 pnpm 常常是一个指向别处的链接（scoop 即如此）。查找过程在解析这种链接时没有保护，一旦当前进程无法跟随该链接就直接抛出，后面所有候选目录——包括真正可用的那一个——都不再检查，于是报告"没有可用的 pnpm"。现在单个候选失败只跳过它自己。
- **启动被拒时说明是哪一项不合法。** 之前八项检查共用同一句"启动参数不合法"，无法区分是 pnpm 没找到、日志路径缺失还是检出目录不规范。现在每条拒绝都指名字段，pnpm 不可用时直接带上原因；找不到 pnpm 时也会列出查找过的目录。
- **保留网络核心的诊断输出。** 核心把每一次修复和每一次拒绝都写在标准错误上，但这些内容除非开发者设置了调试开关否则被直接丢弃。用户报告"连不上"时因此没有任何记录可查，只能从外部猜测。现在它们与核心自身的状态存放在一起，可随问题反馈一同提交。

### English (en-US)

- **Fix an inbound connection being refused and then retried forever.** Once a connection was established, the receiving computer had to start DSH for it, and that launch was refused because no usable pnpm could be found — so the connection closed, reconnected and failed again without end. The interface reported the loop as "cannot reach the coordinator", which pointed at something entirely unrelated: the coordinator was reachable throughout.
- **Fix the pnpm search ending on one unresolvable candidate.** On Windows pnpm is usually a shim that links elsewhere, as scoop's does. Resolving that link was unguarded, so a link the current process could not follow threw out of the whole search: every later directory — including one holding a working pnpm — went unexamined and the launcher reported no runnable pnpm at all. A failing candidate is now skipped on its own.
- **Say which field a refused launch rejected.** Eight separate checks shared one "launch input is invalid" sentence, which could not distinguish an unresolved pnpm from a missing log path or a non-canonical checkout. Each refusal now names its field, an unavailable pnpm carries its own reason, and a failed search lists the directories it looked in.
- **Keep the networking core's diagnostics.** The core reports every repair and every refusal on standard error, and all of it was discarded unless a developer had set a debug switch. A user reporting "it cannot connect" therefore left no record to read, and diagnosis came down to guessing from the outside. Those lines now sit beside the core's own state, where a bug report can carry them.

## 0.1.70 — 2026-09-23

### 简体中文 (zh-CN)

- **修复先登录的机器对后登录的机器不可达。** 在线状态由协调器按"设备 + 账户"记录，而核心上报的账户只在恢复设备时设定一次——取自凭据里记录的账户——之后用户登录、切换账户或登出都不会更新。先登录的那台机器因此一直按旧账户上报在线状态：它确实在线，但对端按自己登录的账户去查却查不到，于是连接被拒为 `p2p.peer_offline`，而两台机器在界面上都显示在线。退出重启之所以能"修好"，只是因为重启会先恢复已保存的登录会话，设备恢复时才拿到了正确的账户。现在登录、登出以及重启时的会话恢复都会更新上报的账户。

### English (en-US)

- **Fix the machine that signed in first being unreachable from the one that signed in second.** The coordinator records presence per device and account, but the account the core reported was set once, while restoring the device, from whatever the credential recorded — and never updated when the user signed in, switched accounts or signed out. The machine that signed in first therefore kept reporting presence for the earlier account: it was genuinely online, the peer looked under the account it was itself signed in to, found nothing, and every attempt was refused as `p2p.peer_offline` while both machines displayed as online. Quitting and restarting appeared to fix it only because a restart restores the saved login session before the device, so the restore finally carried the right account. Signing in, signing out and restoring a session on restart now all update the reported account.

## 0.1.69 — 2026-09-22

### 简体中文 (zh-CN)

- **修复点"连接"仍然回答 `p2p.server_unavailable`。** 0.1.68 修复了信令订阅的自动修复，但只接在自动重连和无界面定时通道上；用户真正会做的动作——手动点击连接——恰恰是唯一不修复信令的路径，于是被顶替的订阅一直停摆，连接始终失败而两台机器都显示在线。现在每次连接前都会先修复信令，健康的连接不受影响。
- **修复首次订阅失败后永远无法恢复。** 核心在创建时如果第一次订阅协调器就失败，之后负责重试的监督协程根本不会启动，而修复逻辑把"没有订阅"当成健康状态直接跳过：这台机器此后永远无法收发信令，且没有任何操作能修回来。现在"没有订阅"被视为需要修复的状态。
- **网络核心接管设备凭据，无界面运行不再需要桌面端。** 设备私钥一直由核心保管，但凭据中说明"这把私钥注册成了哪台设备"的部分——协调器签发的设备编号、证书、所属账户——只存在桌面端的加密存储里，核心读不到。因此 `dshkerd` 独立运行时能应答所有调用却不知道自己是谁：不建立协调器订阅、不上报在线状态，对端看到的永远是一台离线机器，而这台机器看起来明明装好了并正在运行。现在核心在完成注册以及桌面端交接凭据时各自留存一份完整记录，启动时自行恢复。升级后首次仍需启动一次桌面端完成交接。
- **修复核心关闭时可能崩溃。** 关闭流程会释放每个账户持有的资源，其中两项做了空值检查，第三项没有：一个尚未完成配置的账户会让核心在退出时崩溃——而这正是负责释放资源的那条路径。
- **修复集成测试在 Windows 上无法启动。** 测试入口没有任何平台判断，协调器二进制的默认路径不带 `.exe` 后缀，在 Windows 上永远指向一个不存在的文件，整套集成测试因此默认跑不起来。

### English (en-US)

- **Fix pressing connect still answering `p2p.server_unavailable`.** 0.1.68 added the signalling repair but wired it only into the reconciliation methods and the headless ticker. The one action a user actually takes when nothing works — pressing connect — was the single path that never repaired anything, so a displaced subscription stayed down and every attempt failed while both machines showed as online. Connect now repairs signalling first, and a healthy subscription is left untouched.
- **Fix a first subscription failure being permanent.** When the very first dial to the coordinator failed while the manager was being created, the supervisor that would have retried was never started, and the repair treated "no subscription" as healthy and returned without doing anything. The machine could then never signal again, with no operation able to recover it. An absent subscription is now repairable.
- **The networking core now owns the device credential, so headless runs no longer need a desktop.** The core always held the machine's private key, but the part of the credential naming what that key was enrolled as — the coordinator-issued device id, the certificate, the account it belongs to — lived only in the desktop's encrypted store, which the core cannot read. `dshkerd` running on its own therefore answered every method while being nobody: no coordinator subscription, no presence, and every attempt toward it saw an offline peer while the machine looked installed and running. The core now records its own complete credential when an enrollment completes and when a desktop hands one over, and restores itself on startup. The first launch after updating still needs the desktop once, to hand the existing credential over.
- **Fix a crash while the core was shutting down.** Shutdown releases the resources each account holds. Two of those references were checked for absence and the third was not, so an account that had not finished being configured crashed the core on exit — on the path whose whole job is to release resources.
- **Fix the integration suite being unable to start on Windows.** The test entry point had no platform handling, so the default path for the coordinator binary lacked the `.exe` suffix and always pointed at a file that cannot exist on Windows, leaving the whole suite unable to run by default.

## 0.1.68 — 2026-09-22

### 简体中文 (zh-CN)

- **修复无界面核心断线后永远无法恢复连接。** `dshkerd` 无界面运行时直接驱动重连引擎，但被新进程顶替或失效的协调器信令订阅从未被修复：管理器永久停摆，之后每次连接都回答 `p2p.server_unavailable`，而两台机器因为在线状态走的是另一条通道仍然显示在线——只有重启应用才能恢复。现在每次重连前都会先修复所有账户的信令订阅，与桌面端已有的修复路径保持一致，健康连接不受影响。
- **修复核心退出时残留进程。** 桌面端关闭 RPC 通道后核心应随之退出，但关闭清理路径持有一个账户锁等待对端会话结束，而对端会话的收尾又需要同一个锁来上报状态，形成互相等待：核心既不退出也不释放，进程残留在后台。现在关闭前先释放账户锁，核心随父进程通道关闭立即退出，不再有残留进程。

### English (en-US)

- **Fix a headless core that could never reconnect after a drop.** When `dshkerd` runs without a desktop it drives the reconnection engine directly, but a coordinator signal subscription displaced by a newer process or otherwise made unusable was never repaired: the manager stood down permanently, every later connect answered `p2p.server_unavailable`, and both machines still looked online because presence travels a different path than signalling — only a restart recovered. Every reconciliation pass now repairs the subscription for all accounts first, matching the repair the desktop shell already had, and a healthy subscription is left untouched.
- **Fix a core that outlived its parent and left a process behind.** The core is a child, not a daemon: it must exit when the desktop's private channel closes. The shutdown path held an account lock while waiting for the peer session to end, and the session's own teardown needed that same lock to report its final state — each waiting on the other, so the core hung instead of exiting. Closing now releases the account lock before waiting on the session, so the core follows its parent channel and no process is left behind.

## 0.1.67 — 2026-09-21

### 简体中文 (zh-CN)

- **修复核心自动重连后再也无法连接对端。** 0.1.64 让网络核心自己为每次连接尝试编号，但核心从 Unix 原始时钟起算，桌面端从另一个起点起算，两者相差约 79 倍。核心自动重连过一次后，记录在案的尝试编号远大于桌面端之后能产生的任何编号，于是每一次新的连接都被判定为"已过期"（`p2p.stale_generation`），Windows 侧表现为再也连不上这台 Mac。现在两端从同一个起点计数。
- **改进连接被判定过期时的提示。** `p2p.stale_generation` 之前落到通用失败文案，用户看不出该做什么；现在归入"这条连接在本机已经不存在或已经失效"，明确提示重新连接即可。
- **修复重复启动时第二个实例静默卡住。** 单实例锁被占用时只调用了 `app.quit()`，它仅仅是"请求"退出，代码会继续等待一个永远不会完成的就绪事件，于是第二个进程既不显示窗口也不退出，直到被系统回收。现在会立即退出。
- **固定代码格式化工具的版本。** 之前声明为可浮动版本，不同机器装到的实际版本对同一批文件的格式判定不同，本地检查通过而持续集成失败。现在锁定为与依赖锁文件一致的确切版本。

### English (en-US)

- **Fix being unable to reach a peer after the core reconnected on its own.** 0.1.64 gave the networking core its own numbering for connection attempts, but the core counted from the raw Unix clock while the desktop counts from a different origin, leaving core-issued numbers about 79x larger. Once the core had reconnected a pair, the attempt on record outranked anything the desktop could produce afterwards, so every fresh connection was refused as `p2p.stale_generation` — which showed up as a Windows peer no longer reaching this Mac. Both sides now count from one shared origin.
- **Explain a connection that was superseded.** `p2p.stale_generation` previously reached the user as the generic failure text with nothing to act on. It now reads as a connection this computer no longer holds, and says that reconnecting resolves it.
- **Fix a second launch hanging silently.** When the single-instance lock was already held, the new process called `app.quit()` — which only requests a quit — and then waited on a ready event that never arrives, so it neither showed a window nor exited until the OS reaped it. It now exits immediately.
- **Pin the code formatter.** It was declared as a floating range, so different machines installed releases that disagreed about how the same files should be formatted, which passed locally and failed in CI. It is now the exact version the dependency lock records.

## 0.1.65 — 2026-09-21

### 简体中文 (zh-CN)

- **增强左下角状态栏入口可见性。** 菜单和命令行按钮现在同时显示图标与文字，保留未读红点、焦点态和原有键盘/无障碍名称，窄窗口下也不会撑破状态栏。
- **加快登录后的可用反馈。** 认证和安全存储确认后立即显示已登录账号；网络列表改为独立加载，加载中、读取失败和重试都在网络区域内反馈，不再让网络请求拖住登录界面或把网络错误误报成登录失败。
- **修复 macOS 登录会话无法持久化。** 桌面启动的 `dshkerd` 写入 Keychain 时不再卡在继承的控制终端；登录确认后的会话会真正保存，重启后可以恢复账号，不再无故回到登录框。
- **恢复网络与账户页的内容容器。** 移除重复的页内“网络与账户”标题，保留远程连接页签作为导航名称，同时恢复统一的表面、边框和内边距，让“我的网络”和账户操作回到清晰的工作区层级。
- **修复后台核心的单实例交接。** 开启网络核心自启时，Launcher 会附加到已经运行的 `dshkerd`，不会再启动第二个设备身份；退出、禁用自启和异常断开都使用明确的交接/释放流程，避免 `owner_busy`、白屏或下次启动无法恢复。
- **拆分基础 VFS 模块。** 路径、安全策略、资源目录和内存存储分离为独立模块，保持原有导出兼容，同时让每个源文件都留在维护和审查上限内。

- **修复 SSH Key 编辑后的连接状态错位。** 已连接或测试中的电脑不能更改 SSH Key 路径；断开并保存新路径后，旧测试结果清除，需使用新身份重新测试，避免列表显示新 Key、隧道却仍用旧 Key。
- **修复协调服务器恢复后再次掉线。** 重建的 P2P 信令订阅不再随一次操作返回而关闭；同时发起的恢复也不会留下互相覆盖的订阅。
- **修复切换服务器时账号信息串台。** 切换协调服务器后，账号和网络内容跟随所选服务器更新，不再显示上一台服务器的信息却对新服务器执行操作。
- **区分可连接与失败设备。** 尚未连接但可以点击连接的电脑使用强调色状态；红色只表示明确失败、撤销或离线，状态仍有文字说明。

- **将 SSH 添加电脑改为明确弹层。** SSH 连接页只显示电脑列表和“添加电脑”入口；表单不再嵌在列表底部，改为带遮罩、标题栏关闭按钮、取消操作和焦点恢复的对话框。网络创建/管理弹层也补齐标题栏关闭按钮。
- **降低网络与账户页的线框密度。** 移除重复的外层/内层卡片边框，网络选择器改用留白布局，设备目录改为行分隔；网络 ID、设备状态和所有操作保持不变。
- **收紧远程 SSH 工作台入口。** “连接”标签页改名为“SSH 连接”，电脑列表提供明确的“添加电脑”操作；新增和编辑表单支持指定本机 SSH Key 路径，核心会把路径作为 OpenSSH 参数传入，私钥内容不会进入渲染器、目录或远端。

- **压缩网络与账户页头部。** 标题、刷新/登出操作合并到同一行，登录账号独占第二行，减少信息散落和垂直占用。

- **收敛网络与账户工作台。** 登录后不再展示账号技术 ID，也不再在同一页重复本机登记恢复和设备配对面板。网络改为单个下拉选择器，创建网络使用旁侧按钮打开弹窗；选中网络后直接查看网络 ID、设备上限和设备列表，名称、上限与删除集中在管理弹窗中。

- **优化网络工作台文案。** 将登录账号、网络选择、已选网络和设备列表改为短标题层级，减少“当前/我的/网络设备”等重复表达；网络 ID、设备上限和在线状态仍然保留。

- **简化“我的网络”信息层级。** 设备名称、设备标识、当前加入的网络 ID、复制操作和“离开网络”现在直接展示，不再需要展开多层折叠；旧凭据若没有保存网络 ID 会明确提示，应用不会猜测目标网络。

- **未就绪状态仍保留本机信息。** 协调服务读取失败或仍在启动时，“我的网络”的设备信息和登录/注册框仍然显示；登录控件会明确置灰，不会把本机身份误报成不存在。开发热更新也不会因请求序号重置而触发 `p2p.request_replayed`。

- **调整远程连接信息架构。** “我的网络”完整卡片（本机身份、登记状态、加入网络和网络成员操作）现在统一放在“网络与账户”页；“连接”页只保留 SSH 连接任务，避免连接操作和账户管理混在同一列表中。

- **修复远程页签和网络列表的可用性。** 已配对但尚未建立连接的电脑现在显示为可连接状态，不再误显示红色离线点；添加页签浮层支持完整键盘焦点进入、循环、Enter、Esc 和焦点恢复；网络管理改为带字段标签的卡片，网络 ID 收入可复制的技术信息区域并说明加入用途。

- **新增独立 `dshkerd` 命令行安装模式。** 服务器和远程电脑现在可以只下载无界面的 Go 核心，不安装 Launcher；Release 提供 macOS、Windows、Linux 六个架构的压缩包、SHA256 清单，以及 macOS/Linux `curl` 和 Windows PowerShell 一键安装脚本。安装必须指定明确版本，校验通过后才会原子替换本地文件，不会偷偷配置服务、复制凭据、建立配对或开启自启动。

- **修复重启/安装后误回到登录框。** 登录只有在系统凭据成功写入并读回后才算完成；凭据 provider 写入失败会明确返回错误，不再先显示登录成功、重启后才回到登录框。启动时账号页会显示正在恢复上次登录，并在服务恢复后自动刷新；只有持久记录不存在或协调器明确拒绝会话时才显示登录表单。
- **修复协调信令被替换后的 `p2p.server_unavailable`。** 配对重试或连接前会修复已关闭/被替换的协调服务器订阅，健康订阅不会被反复重建；无需重启整个 Launcher 才能恢复。

- **收敛网络与账户页的信息层级。** 保留设备名称、设备标识、已加入网络 ID、复制和离开操作；加入后未登录状态显示为“已加入 · 未登录”，下一步只提示登录管理网络和配对设备。服务会话显示为“服务在线”，暂时忙碌的 P2P 错误不再以红色技术码占据主界面。
- **修复开机自启状态误报。** 设置页现在按主进程真实的扁平 IPC 失败结构读取状态；核心暂不可用时显示明确提示，并提供一次显式重新读取，不再把真实拒绝统一显示成“无法读取开机自启状态”。
- **修复启动后登录状态偶尔消失。** 网络状态栏和账户页现在共享核心通道附加、服务激活和当前用户读取，不会把并发恢复误报成 `p2p.helper_busy`/`p2p.service_busy`；服务会话恢复后会自动重读暂时的登录要求，明确登出仍保持登出，登录表单也不再与“正在读取账户状态”同时出现。
- **修复关闭后点击桌面图标无法恢复窗口。** 关闭按钮最小化到托盘后，Dock/桌面图标重新激活会恢复并聚焦已有窗口，不再只有菜单栏图标可以唤回界面。

### English (en-US)

- **Make the bottom-left status-bar actions easier to discover.** Menu and Console controls now pair their icons with short visible labels while retaining the unread dot, focus states, and existing keyboard/accessibility names without widening the supported compact layout.
- **Make sign-in feel immediately usable.** Once authentication and secure session persistence are confirmed, the signed-in account appears immediately; network discovery now owns its loading, failure and retry feedback inside the Network section instead of holding the login screen open or presenting a network error as an account failure.
- **Restore the Network & account content surface.** Remove the duplicate in-page “Network & account” heading while keeping the remote tab as navigation, and restore one consistent surface, border, and inset so My network and account actions read as one workspace.
- **Fix single-owner handoff for the headless core.** When networking autostart is enabled, Launcher attaches to the existing `dshkerd` instead of starting a second device identity; quit, autostart changes, and abnormal disconnects use an explicit handoff/release path so `owner_busy`, blank screens, and unrecoverable next launches do not recur.
- **Split the foundation VFS module.** Path/security policy, resource catalog, and in-memory storage now live in separate modules with the same barrel exports, keeping each source file within the maintenance and review budget.

- **Keep SSH identity edits and connection state in sync.** A computer being tested or connected cannot change its SSH key path; after disconnecting and saving a new path, its previous test result is cleared so the new identity must be tested again.
- **Keep coordinator signaling alive after recovery.** A repaired P2P subscription no longer closes when the operation that requested it returns, and concurrent repairs do not replace one another with orphaned subscriptions.
- **Keep account actions scoped to the selected server.** Switching coordination servers replaces the account and network view for that server, rather than showing the previous server's data while sending actions to the new one.
- **Distinguish connectable computers from failures.** A computer ready for a connection now uses an accent indicator; red is reserved for confirmed failures, revocations, or offline states, alongside a written label.

- **Make SSH add-computer a deliberate dialog.** The SSH tab now keeps only the computer list and one Add computer entry point; the form no longer sits inline below the list and instead has a backdrop, title-bar close action, Cancel action and focus restoration. Network create/manage dialogs also have visible title-bar close actions.
- **Reduce wireframe density in Network & account.** Repeated outer and inner card borders are removed, the network picker uses spacing instead of a boxed surface, and the device directory uses row separators; network IDs, presence and actions remain unchanged.
- **Make the remote SSH workspace explicit.** The first tab is now “SSH connections” and the managed-computer list has a clear Add computer action. Add and edit forms accept an optional local SSH key path; the core passes that path to OpenSSH without exposing or transferring private-key contents.

- **Compress the Network & account header.** The title and refresh/sign-out actions share one row, with the signed-in account on the second row so the page starts with a compact identity block.

- **Simplify the Network & account workspace.** Signed-in users no longer see account technical IDs or duplicate enrollment/recovery and pairing panels on the same page. Networks use one labelled picker, Create network opens a nearby modal, and the selected network exposes its ID, device limit, and member directory; rename, limit, and deletion live in the management modal.

- **Tighten Network & account copy.** The signed-in account, network picker, selected network, and device directory now use a shorter title chain without repeated “current/my/network” wording; network IDs, limits, and presence remain visible.

- **Flatten the My network hierarchy.** The device name, device ID, joined network ID, copy actions, and Leave network action are now visible together instead of hidden behind nested disclosures; legacy credentials without a stored network ID are stated explicitly rather than guessed.

- **Keep local identity visible before readiness.** If the coordinator is still starting or its catalog read fails, My network still shows the device information and a clearly disabled sign-in/register form. Renderer hot reloads also keep request IDs monotonic instead of producing `p2p.request_replayed`.

- **Refine the remote-connection information architecture.** The complete My network card (local identity, enrollment status, network joining, and membership actions) now lives under Network & account; Connect is limited to SSH connection tasks so connection and account management do not compete in one list.

- **Fix remote-tab and network-list usability.** Paired computers without a live session now show as available instead of a misleading red disconnected dot; the add-tab popover has complete keyboard entry, looping, Enter, Escape, and focus restoration; network management uses labelled cards with copyable technical network IDs and a clear join explanation.

- **Add standalone `dshkerd` CLI installation.** Servers and remote peers can install the headless Go core without Electron; releases provide archives for all six macOS, Windows, and Linux targets, SHA256 metadata, and one-command POSIX/PowerShell installers. Installation requires an explicit version, verifies the archive and manifest before atomic replacement, and never silently configures a service, copies credentials, pairs a device, or enables autostart.

- **Keep the account signed in after restart or installation.** Sign-in is published only after the credential provider accepts and reads back the session; a provider write failure is surfaced instead of looking successful until the next launch. The account page shows restoration progress and refreshes automatically when the service comes back. Sign-in is requested only when the durable record is absent or the server explicitly rejects the session.
- **Recover coordinator signalling after a socket is displaced.** Pair retry or connect repairs a closed or superseded coordinator subscription without replacing a healthy one, so `p2p.server_unavailable` no longer requires restarting the entire Launcher.

- **Clarify the Network & account hierarchy.** Device name, device ID, joined network ID, copy actions, and Leave remain visible; a joined signed-out device reads “Joined · signed out”, and the next step is simply to sign in before managing networks and paired devices. Coordinator presence is labelled “Service online”, while transient P2P busy codes no longer dominate the page as red technical errors.
- **Fix false start-at-boot errors.** Settings now reads the main-process flat IPC failure shape correctly; a temporarily unavailable core gets explicit copy and a deliberate retry instead of every real refusal being shown as “could not read start-at-boot state”.
- **Keep the account visible after a concurrent startup restore.** Core attachment, service activation, and current-user reads now share one in-flight request, so normal startup races no longer become `p2p.helper_busy`/`p2p.service_busy`. A provisional login-required response is retried after the service session is restored, explicit sign-out remains final, and the login form no longer appears beside an account-loading state.
- **Reveal the window when the app icon is clicked again.** After the close button hides the window to the tray, Dock/desktop activation now restores and focuses the existing window instead of leaving it visible only through the menu-bar icon.

## 0.1.64 — 2026-09-19

### 简体中文 (zh-CN)

- **网络核心可以不开 Launcher 独立运行。** `dshkerd` 现在把 operator 明确给过的参数记在 state 目录的 `config.json` 里，`serve`、`call`、`pair`、`connect`、`service` 等命令之后可以不带参数直接运行；显式参数仍然优先，并会覆盖回写。
- **支持开机自动启动网络核心。** macOS 使用 launchd、Windows 使用注册表启动项，由 `dshkerd autostart` 自行安装和卸载；设置面板新增开关，与命令行共享同一份注册状态。其他平台会明确说明不支持，而不是假装成功。
- **掉线后的自动重连改由网络核心负责。** 递增退避、终止性拒绝码判定、重新授权后清除记录都下沉到核心，桌面端与无界面主机共用同一份实现。没有桌面会话的机器现在能自己恢复掉线的连接，不再需要有人打开 Launcher 点一次连接。
- **修复重连后远程工作台地址失效。** 由核心完成的重连会分配新的连接代次，桌面端不再把上一次连接的网关地址交给标签页；页面会自动改用新地址，无需用户操作。
- **修复 `dshkerd service configure` 在不指定固定密钥时始终失败。** 请求里的空值会被核心的严格解码拒绝，命令因此报告"核心不可用"，而核心其实正在运行；现在会报告真实原因。
- **修复拔掉显示器后窗口留在已消失的屏幕上。** 之前只处理了分辨率变化，没有处理显示器插拔，所以窗口会停在不存在的坐标上；重开 Launcher 也无法恢复，因为记住的位置会被丢弃并被启动过程覆盖。现在插拔显示器会把窗口移回可操作的屏幕，记住的位置会按当前显示器布局校正后再使用，并且只有标题栏真正可以抓取时才算窗口可见——跨屏摆放的窗口不会再停在屏幕边缘只露出一个像素。
- **修复停止后再次启动仍提示“上一个内核操作尚未结束”。** 忽略停止前已经发出的异步运行状态回报，避免旧的 `running` 状态覆盖已确认的 `stopped` 状态；停止后可以立即重新启动 DSH Web。
- **启动或更新时自动打开命令行日志。** 一键启动、Core 更新、版本切换和插件安装/更新/卸载等操作接受后，底部命令行日志自动展开，进度和失败原因无需再手动寻找；用户主动关闭后不会被每一行新日志反复打断。
- **把左下角两个悬浮按钮移到底部状态栏。** 侧边栏按钮使用菜单图标，命令行（实时输出）按钮使用命令行图标，未读输出用小红点提示；两个按钮不再悬浮在界面左下角，而是作为状态栏最左侧的一组图标按钮。协议、作用域和网络信息保持在右侧。两个按钮在状态栏原有高度内显示，操作进行中也不会被进度条挤走或隐藏。隐藏侧边栏时不再需要为避让让位而上移，Run 页面左下角也不会再被遮挡。

### English (en-US)

- **Run the networking core without opening Launcher.** `dshkerd` records the parameters an operator explicitly supplied in `config.json` under the state directory, so `serve`, `call`, `pair`, `connect`, and `service` can later run with no arguments. Explicit arguments still win and are written back.
- **Register the networking core to start at boot.** macOS uses a launchd agent and Windows uses the registry run key, installed and removed by `dshkerd autostart` itself; a Settings toggle shares that one registration with the command line. Other platforms report that they are unsupported instead of pretending to succeed.
- **Move reconnection into the networking core.** The widening backoff, the terminal-refusal decision, and clearing a recorded stop after re-authorization now live in the core, so the desktop shell and a headless host share one implementation. A machine with no desktop session recovers a dropped connection on its own instead of waiting for someone to open Launcher and connect again.
- **Fix the stale remote workbench address after a reconnection.** A reconnection performed by the core now carries a new attempt generation, so the desktop no longer hands a tab the previous attempt's gateway address; the page moves to the live address with no user action.
- **Fix `dshkerd service configure` always failing without a pinned key.** The absent value was sent as a null the core's strict decoder refuses, so the command reported that the core was unavailable while it was in fact running and serving. It now reports the real cause.
- **Fix the window staying on a monitor that was unplugged.** Only resolution changes were handled, not monitors being attached or removed, so the window stayed at coordinates that no longer existed — and reopening Launcher did not help, because the remembered position was discarded and then overwritten during startup. Attaching or removing a display now moves the window back onto a reachable screen, a remembered position is corrected against the current display layout before it is used, and a window counts as visible only when its title bar is genuinely grabbable, so one spanning two monitors no longer strands itself on a one-pixel sliver at the screen edge.
- **Fix relaunching DSH Web after an explicit stop being rejected as already in progress.** A runtime observation that began before stop can no longer overwrite the confirmed stopped state after it returns, so the next DSH Web launch is admitted immediately.
- **Open command-line output automatically for accepted work.** One-click launch, Core updates, version switches, and plugin install/update/uninstall operations now reveal the bottom command-line log as soon as they are accepted; closing it remains respected until a later operation starts.
- **Move the two lower-left floating buttons into the bottom status bar.** The sidebar control now uses a menu icon, the console (live output) control uses a command-line icon, and unseen output is marked with a small red dot. They form a leading icon-button group in the status bar instead of floating over the lower-left corner, while protocol, scope, and network facts stay on the trailing side. Both fit inside the status bar's existing height and stay operable beside a running operation's progress strip. Hiding the sidebar no longer needs a clearance offset, and the Run page's lower-left corner is never covered by Launcher controls.

## 0.1.63 — 2026-09-18

### 简体中文 (zh-CN)

- **修复升级/重启后账号页错误显示登录框。** 启动恢复与首屏账户查询现在按协调器串行共享持久会话；临时忙、超时或 helper 不可用不会删除已保存登录状态，只有服务端明确判定会话失效才要求重新登录。
- **修复 Token 统计无法读取新格式会话。** 兼容 DSH 的 `session.v2.jsonl.zstd` 与 `session.v3.jsonl.zstd`，同一会话目录只读取最高版本，避免最近 7 天数据被误报为“无法读取”。
- **改进可安装扩展列表刷新失败提示。** Git 刷新现在会把命令、退出码和输出尾部写入用户目录下的 `.dshlauncher/logs/plugin-catalog.log`，同时在控制台显示可追踪的失败原因；失败时保留当前列表，并提示检查网络、代理和 GitHub 访问。

### English (en-US)

- **Keep the signed-in account after restart or upgrade.** Startup recovery and the first account read now share one serialized restore; temporary busy, timeout, and helper transport failures no longer clear the saved session, while explicit server-side session refusals still request sign-in.
- **Read versioned DSH session logs for token statistics.** The reader supports `session.v2.jsonl.zstd` and `session.v3.jsonl.zstd`, selects the newest format per session, and no longer reports valid recent sessions as unreadable.
- **Improve failed installable-extension catalog refreshes.** Git refreshes now record the command, exit status, and output tail in the Launcher log, stream a traceable reason to Console, preserve the current list on failure, and explain how to check network, proxy, and GitHub access.

## 0.1.62 — 2026-09-18

### 简体中文 (zh-CN)

- **修复 Launcher 更新下载体验。** 更新卡片的主按钮保持正确样式，更新说明按 Launcher 当前语言显示；下载现在在 Launcher 内展示进度并保存到系统“下载”目录，不再跳转到浏览器。

### English (en-US)

- **Fix Launcher update downloads.** The update card keeps the correct primary-button style, release notes follow the selected Launcher language, and downloads now show in-app progress before saving the installer to the system Downloads folder instead of opening a browser.

## 0.1.61 — 2026-09-18

- **修复多端频繁上下线后的 P2P 恢复。** 旧连接在新连接已经接管后迟到清理时，不再误删新连接的网关；TURN 凭据会在过期前刷新，临时获取失败也会在下一次连接重试，不再必须重启应用。
- **补充多端断线恢复验证。** 覆盖双向替换、频繁上下线、稳定网关地址、直连 UDP、运行时探测和并发 TURN 刷新。

## 0.1.60 — 2026-09-18

- **侧边栏「运行」改为「浏览器」。** 该页签主要是远程 DSH Web 浏览器视图，而非本地
  运行控制，改名使导航更直观。英文同步改为 "Browser"。
- **浏览器标签页增加选中高亮。** 之前选中/未选中 tab 只有文字深浅色差异，很难区分。
  现在选中的 tab 底部多一条 accent 色横线，与 Chrome/Safari 的标签页效果一致。
- **网络列表中直接显示网络 ID 和复制按钮。** 之前网络 ID 藏在展开的「管理网络」设置
  里，现在每行网络名下方直接展示 `网络ID` + 复制按钮，无需展开即可复制。
- **控制台增加「清空输出」按钮。** 日志过多时可直接清空画面内容（磁盘日志文件不受
  影响，导出/显示在文件夹功能依然可用）。
- **远程连接断线后用户点击连接时立即清除退避重试全部状态。** 过夜断线后若重试退避
  到了 60s 周期，用户手动点连接会先执行 `resumeConnectivity()` 清除所有退避计时器
  和 terminal refusals，让重连立即发起。

## 0.1.59 — 2026-09-17

- **远程工作台加载失败时显示友好的排障页面。** 此前防火墙拦截 UDP 导致连接建立后
  webview 白屏并显示裸的 `p2p.stream_failed`，现在页面用中/英文列出常见原因和检查
  步骤（防火墙、UDP 连通性、网络环境），用户无需查阅文档即可自助修复。
- **`p2p.stream_failed` 错误码纳入连接失败分类体系。** 如果该代码出现在连接状态中，
  也正确归入「直连不可达」类别，显示对应的中文/英文提示。

## 0.1.58 — 2026-09-17

- **修复第三台及以上设备无法建立连接、断线后长时间无法恢复。** 协调器过去按**目标
  设备**索引连接尝试，因此一个目标同时只允许一个拨号方。而网络上限 10 台、自动连接
  会向每个已授权配对拨号，于是三台以上时两台机器争同一目标会互相饿死；更关键的是
  活跃会话每 20 秒续租一次，那个 `p2p.connection_busy` 拒绝**永不失效**——对端还活着
  时，你重拨永远被拒，这就是"断线不能恢复"。改为按尝试 id 索引（双方在续租、结束和
  每条信令里本来就都带这个值），租约的 `pairId` 字段保持不变以兼容已部署的客户端。
- **修复撤销/删除配对后对方仍能连接。** 两条路径都只写了 `pairs.state='revoked'`，
  而授权判定走的是"网络共同成员"，两端仍然绑定，所以照旧发放租约、活跃会话照旧续租。
  界面当时明确写着"撤销会立即断开与这台电脑的 P2P 会话"，那句话是假的。现在撤销在
  发起和续租两处都会被强制检查。

- **修复同一设备重连被永久拒绝（连不上、断线不恢复）。** 一台设备只持有一条信令
  连接：设备 id 由公钥派生、连接经 mTLS 认证，所以新连接必然是同一台机器重连，
  最新的那条才是活的。但协调器过去是**拒绝新连接**（`p2p.device_busy`）而不是踢掉
  旧的。这条 socket 上没有 ping/pong、没有读超时、也没有空闲检测，而且 Hijack 之后
  Go 会清掉原有的 deadline，因此客户端被强杀、或 NAT/防火墙静默丢弃连接时，服务端
  永远不会发现——那条死连接连同它的 goroutine、channel 和 TCP socket 一直留着，
  该设备**在进程重启前再也无法建立信令连接**。客户端把它变成了死局：没有任何代码
  读 `p2p.device_busy`，而它含 "busy" 子串会被归类为 `retry`，于是界面一直提示
  "稍后重试"，永远重试不成功。现在新连接顶替旧连接。
- **修复顶替可能导致两端无限互踢。** 被顶替的一方必须停下，不能重连。客户端的
  supervisor 在任何断连后 1 秒就重连，而重连会顶掉对方，对方再过 1 秒又顶回来——
  无限循环，两边都不可用。协调器改为发送带明确原因的关闭帧
  （`p2p.signal_superseded`，而非直接切断），客户端据此判定"我是被顶替的"并停止
  重连、保持 down 状态，这样后续尝试会立刻返回真实错误码而不是挂起。仅靠突然断开
  无法与"网络断了"区分，所以这个原因字符串是两端的协议约定。

- **修复 macOS 菜单栏看不到托盘图标。** 托盘直接用 `icon-512.png`——一张 512px、
  96% 不透明、平均色为中灰的应用插画——缩到 16px 后就是一团灰方块，在菜单栏里与
  "没有图标"无法区分。macOS 需要的是 template 图像（纯黑 + alpha，由系统按浅色/
  深色菜单栏重新着色并在高亮时反色），因此新增专用字形 `trayTemplate.png`（附 @2x
  供 Retina 使用）并调用 `setTemplateImage(true)`。Windows 和 Linux 没有 template
  约定、按原图绘制，继续使用彩色应用图标。
- **修复单击托盘图标直接退出应用。** `tray.on('click')` 绑的是 `quitApp()`，所以
  在菜单栏上误点一下就无确认地杀掉整个应用，而同一个托盘菜单里还另有一项"显示"
  做同样的手势。现在左键单击改为显示窗口，退出只保留为明确的菜单项。
- **修复托盘创建失败后应用彻底无法退出。** `isTrayActive()` 决定
  `window-all-closed` 是否放行退出，而 `currentBehavior` 在 `new Tray()` 之前就已
  被赋值。若构造抛错（Linux 无系统托盘、图标缺失或损坏），关闭处理器根本没装上，
  窗口真的关掉了，但 `window-all-closed` 仍认为托盘生效而提前返回——于是没有窗口、
  没有托盘图标、也没有任何退出途径，单实例锁还被占着。现在构造失败会退回
  `quit` 行为，让关闭按钮成为可用的退出出口。

- **修复 ⌘Q / 菜单退出后进程残留、托盘图标消失、只能强制结束进程。** 0.1.56 和
  0.1.57 只修好了托盘那一条退出路径：`forceQuitting` 标志仅由托盘的 `quitApp()`
  设置，而 ⌘Q、应用菜单"退出"、Dock 右键退出和终止信号都直接走 `app.quit()`，
  绕过了它。于是退出流程跑完（core 被停掉、P2P 会话被关闭），Electron 关窗口时
  "最小化到托盘"拦截器仍然生效，`preventDefault()` + `hide()` 取消了这次退出。
  结果是一个看不见的进程：没有窗口、没有托盘图标（已在退出流程开头被销毁）、
  core 已停止、单实例锁仍被占用——再次双击快捷方式只会 `show()` 那个背后没有
  core 的空窗口，P2P 也因此再也连不上。现在所有退出路径共用一个退出序列，
  **第一步**就解除关闭拦截。
- **修复清理失败后永远退不出去。** 任一 owner 清理失败时，旧代码复位
  `shutdownInProgress`、不再调用 `app.quit()`，之后每次退出都重跑同一个必然失败
  的清理。现在清理失败仍然结束进程（退出码 1）并记录原因：用户已经要求离开，
  留下一个占着单实例锁的隐藏进程比不干净的退出更糟。
- **托盘图标改为在退出确定继续之后才销毁。** 之前在退出流程开头就销毁，一旦清理
  失败，用户连唯一可用的重试入口也没了。
- **缩短退出时的卡顿。** `stopChild` 原先无条件先等 10 秒才发 SIGTERM；私有通道
  关闭本身就是 core 的停止信号，正常情况 1 秒内即退出，因此首次等待缩短为 1 秒，
  升级到 SIGTERM/SIGKILL 的预算不变。

## 0.1.57 — 2026-09-17

- **修复双击快捷方式无法恢复隐藏到托盘的窗口。** `second-instance` 事件处理器只处理
  了最小化窗口（`isMinimized()` → `restore()`），未处理隐藏到系统托盘的状态。窗口
  `isMinimized()` 返回 false、`focus()` 对隐藏窗口无效，用户双击桌面/开始菜单图标
  后看不到任何反应。现在增加了 `show()`，与托盘菜单"显示 DSHKer Launcher"一致，将
  隐藏窗口重新显示到前台。Windows 和 macOS 同时生效。
- **修复托盘右键菜单"退出"后进程残留。** `forceQuitting` 标志和关闭拦截已在 0.1.56
  中实现，但托盘右键"退出"按钮直接调用了 `app.quit()` 而非 `quitApp()`，导致
  `forceQuitting` 未被设置，关闭拦截器用 `preventDefault` 阻止了进程退出，窗口被
  隐藏后进程仍占着单实例锁，后续双击快捷方式无法启动。现在托盘"退出"正确调用
  `quitApp()` 设置标志后退出。

## 0.1.56 — 2026-09-17

- **修复 Mac 重启后 Windows 连不上（`p2p.connection_busy`）。** 新 Connect 无条件替代
  旧 session，不再检查 transport 是否还活着——ICE 检测远端断开需要 25-30 秒，
  `retireDeadLocked` 在这个窗口期内返回 false 导致新连接被拒。现在旧 session 被
  直接取消替换，不管它的 transport 状态如何。
- **修复 `p2p.runtime_http_failed`。** `ServeDirectoryStreams` 的 `mux.Accept()`
  与 HTTP gateway 的 `Listener.Accept` 竞争 stream 通道，HTTP 请求帧被目录服务
  吃掉后无处转发导致 probe 失败。临时禁用此功能，待 stream 分流机制就绪后再接
  入。
- **修复托盘退出后无法启动。** 托盘 `app.quit()` 被窗口 close handler 的
  `preventDefault` 拦截，进程没退出却销毁了托盘和隐藏了窗口。`forceQuitting` 标
  志让真正退出绕过拦截。

## 0.1.55 — 2026-09-16

- **系统托盘图标。** 桌面右下角（Windows）或菜单栏（macOS）新增 DSHKer Launcher
  托盘图标。点击托盘图标直接退出程序；右键菜单提供"显示"/"切换关闭行为"/"退
  出"操作。
- **关闭按钮默认最小化到托盘。** 点击窗口关闭按钮不再退出程序，而是隐藏到系
  统托盘，程序继续在后台运行。可在**设置 > 关闭行为**中切换为"直接退出"。
- **设置面板新增关闭行为选项。** 设置 → Launcher 标签页新增"关闭行为"配置
  项，可选"最小化到系统托盘"或"直接退出"，切换即时生效并持久化。
- **修复 CI 构建失败。** prettier 格式检查和类型检查问题已修复，预加载表面测
  试已更新以包含新的 tray IPC 通道，mock 中补充了缺失的 tray 桩。

## 0.1.54 — 2026-09-16

- **系统托盘图标。** 桌面右下角（Windows）或菜单栏（macOS）新增 DSHKer Launcher
  托盘图标。点击托盘图标直接退出程序；右键菜单提供"显示"/"切换关闭行为"/"退
  出"操作。
- **关闭按钮默认最小化到托盘。** 点击窗口关闭按钮不再退出程序，而是隐藏到系
  统托盘，程序继续在后台运行。可在**设置 > 关闭行为**中切换为"直接退出"。
- **设置面板新增关闭行为选项。** 设置 → Launcher 标签页新增"关闭行为"配置
  项，可选"最小化到系统托盘"或"直接退出"，切换即时生效并持久化。

## 0.1.53 — 2026-09-16

- **远程工作区目录浏览已修复。** P2P 连接的远端目录服务
  `ServeDirectoryStreams` 从未接入 `Manager.run()`（v0.1.48 引入后一直是死代
  码），所以每次 `remote.roots` RPC 请求发出后，远端 mux 上无人应答，请求挂
  起超时，用户看到"添加远程工作区"无法拉起远端文件夹目录。现在应答方的
  `Manager` 持有 `RootProvider`，在连接建立后启动 `ServeDirectoryStreams` 监
  听目录请求，通过私有通道向 Launcher 获取授权根目录列表并应答。
- 授权根目录管理尚未接入用户界面，当前返回空列表（远端显示"尚未授权任何目
  录"），后续通过 workspace registry 接入实际目录授权后即可浏览远端文件夹。

## 0.1.52 — 2026-09-16

- **The window stays visible when monitors or RDP sessions change.** Disconnecting
  an external monitor, ending a remote-desktop session, or switching display
  layouts could leave the Launcher window on a desktop that no longer exists —
  positioned where a secondary monitor used to be, or at the resolution of the
  RDP session that just ended. The window is now repositioned to the centre of
  the primary display whenever the display configuration changes, and on every
  startup it checks that its saved bounds sit on at least one available display.
- **Window position and size survive a restart.** The last window bounds are
  written on every move or resize and restored on the next launch.
- **Double-clicking the shortcut now brings up the running window instead of
  starting a second process.** An Electron single-instance lock prevents the
  multiple processes that shared the same data root, core socket and catalog
  files — the extra instance failed to start its own dshkerd (the data directory
  was taken), and the user saw nothing at all.

## 0.1.51 — 2026-09-16

- **A stale session after a peer restarted no longer blocks reconnection.**
  When the remote machine went offline and came back, the old session's
  transport endpoints still occupied the outbound (or inbound) slot at the
  moment the new connect arrived, and every attempt was refused as
  `p2p.connection_busy`. The connect path now retires a session whose
  context or transport is already done — the peer is gone and the cleanup is
  merely racing the next attempt — so a fresh one replaces it instead of
  being denied by a corpse.
- **Disconnect now tears down an inbound (answered) session.** The
  Disconnect function only checked the outbound `sessions` map, so a session
  created by the far side dialling this machine could not be terminated from
  the Run page; the button returned `p2p.not_connected` and the session
  lived on. The inbound map is checked too, so the user can close a session
  regardless of which side opened it.

## 0.1.50 — 2026-09-16

- **A pair now owns one session per direction, not one slot shared between both.**
  This machine's own Run tab dials out; the far machine's tab is the answered
  session here. Before, whichever side dialled first kept the other side's
  "connect" answering `p2p.connection_busy` for as long as its session lived,
  with a tab that showed the answered session's stage and no address of its own
  to load — a function that had already connected appeared disabled with no
  explanation. The core now tracks inbound sessions and their endpoints
  separately from outbound ones, and revocation clears both attachments.
- **A restarted process no longer writes off every peer as stale.** Attempt
  generations were seeded from a counter starting at 1, so a fresh process that
  was forced to reconnect named every attempt "older" than the previous process's
  last attempt: the peer refused it as stale, the stage never recorded it, and
  every runtime request that followed died as `p2p.runtime_request_unscoped`
  until that peer restarted too. Generations are now seeded from the wall clock,
  so each process start sets every attempt above anything the peer has seen
  before — including peers running builds that never learned attempt lineages.
- **A failed result from asking about a connection no longer locks that tab
  forever.** A promise that rejected left the in-flight marker in place, so the
  tab never asked again and entered a terminal state: "ready" with no page
  loaded. The ask now catches the refusal and clears the marker, so the next
  render cycle retries normally.
- **The host no longer refuses answered runtime requests for not being in a
  "starting-runtime" stage that the inbound session's document was never told.**
  The core owns one slot per direction now and asks for a runtime only while an
  answered attempt is at `starting-runtime`, so the only gate is whether the pair
  is still recorded and active. Requiring a stage the doc never had made every
  answered attempt die as `p2p.runtime_request_unscoped`.

## 0.1.49 — 2026-09-16

- **0.1.48 could not connect to any paired computer.** The list of paired
  computers moved into the core in 0.1.48, and the pin that authorizes a connection
  was recorded under the server's own pairing id instead of the id a connection
  actually names — the far computer's device id. Nothing could look that pin up, so
  every attempt was refused with `p2p.pair_unauthorized`, and that refusal is one
  auto-reconnect treats as final: each computer was written off after a single
  attempt until the machine's own network changed. SSH connections were unaffected.
- The pins are now in place before the core reports the machine online. A
  connection made in the first seconds after launch used to be refused for a pin
  that had not been derived yet, which looked exactly like a computer that cannot
  be reached.
- **A connect button that does nothing now says why.** Refusals that prove nothing
  was started (the helper or the service was busy) no longer count as an unknown
  outcome that blocks every later attempt; a refusal is read back so the attempt is
  resolved where it happened, and the Run page reads the connection state when it
  opens instead of only the Remote connections page doing so. A disabled connect
  button explains itself, and a refused attempt leaves its code on screen.
- A computer that was refused before its pin existed is tried again as soon as the
  core announces a new paired-computer list, instead of staying written off until
  the machine's network changes.
- A failed paired-computer pass is written to the core's log rather than dropped:
  its only symptom used to be "this computer will not connect".

## 0.1.48 — 2026-09-15

- **The paired-computer list looks after itself.** Which computers you may connect
  to was rebuilt whenever a page asked for it: the Run tab read the server's
  pairings, pinned them and rewrote the stored list, so a computer paired elsewhere
  appeared only the next time that menu was opened, and a list nobody opened could
  stay wrong. The core now does that work on its own — on the same 30-second
  interval it already uses for the network device list, and immediately after
  anything that can change a pairing (joining or leaving a network, binding or
  unbinding a device, approving, revoking or adopting one) — and tells the window
  when the list changes. A computer paired elsewhere appears while the list is
  open; leaving a network drops its computer right away instead of up to half a
  minute later.
- Opening the Run tab no longer asks the server anything: it reads what the core
  already holds.

## 0.1.47 — 2026-09-15

- **A window that vanishes now says why.** When a renderer, a GPU or utility
  process, or the main process itself dies, the reason and exit code are written
  to `~/.dshlauncher/logs/main-faults.log` before the process goes. Until now the
  application had no such record at all: a crashed renderer and a window someone
  had closed looked identical from the outside, so "it just closed" could not be
  answered from the machine. An uncaught exception in the main process is recorded
  and then ends the process deliberately, with the exit code the default would have
  produced; a renderer or child process that dies is recorded and left for Electron
  to recover, because exiting there would turn a recoverable loss into a shutdown.
- This is a record of unexpected deaths, not crash reporting: a normal exit, a
  window you closed, and a process you stopped write nothing, so an empty file is
  the normal state.

## 0.1.46 — 2026-09-15

- **The network ID is shown outright.** It sat behind a "network technical
  details" disclosure, which put the one value a user opens the row to copy — the
  ID another machine joins by, and the ID support asks for — one click deeper than
  everything around it. The row now shows the label, the ID and its copy button on
  one line, with the explanation below. The account's own technical ID stays a
  disclosure; the machine's is not what this row is for.

## 0.1.45 — 2026-09-15

- **The Connect page stops asking the server a question it already has an answer
  for, and stops guessing when it does not.** Whether this machine belongs to the
  account signed in here was decided by a read that always went to the server, and
  a directory the core had not read yet came back empty — which the page read as
  the positive claim "this machine is not bound" and reported a perfectly bound
  computer as belonging to another account. It now reads the same directory every
  other page reads, and an unread snapshot is left as "not looked yet" rather than
  turned into a verdict. The page follows the core's change announcements, so the
  answer appears by itself as soon as the first read lands.
- The device-directory contract now has exactly one path: the two leftovers from
  before the core owned the directory (a per-network read and an account read that
  forced a coordinator fetch) are gone, so nothing in the interface can read the
  same list a second way and disagree with the first.

## 0.1.44 — 2026-09-15

- **A leftover workbench no longer blocks the next launch.** With a fixed port, a
  DSH Web left behind by an earlier run is supposed to be stopped and replaced —
  but the check that recognizes "this is one of ours" only matched the command
  line the way Unix renders it, and Windows renders every argument of a spawn in
  quotes. The launcher's own leftover was therefore judged a foreign program and
  the launch was refused with `runtime.port_in_use`, naming nothing the user could
  act on. Quoted and unquoted forms are now recognized alike, and a name that only
  looks similar (`…bin.js webhook`) is still refused rather than killed.
- The launcher log for that failure says what to do: the port is held by another
  process, that is usually a leftover workbench, and it can be stopped or another
  port chosen in Settings.

## 0.1.43 — 2026-09-15

- **The device list no longer reports a failure it does not have.** Opening the
  account page could show "the device list could not be read" over a list that was
  already on screen: the page asks the core to read when it opens, and that call
  could be the one that lost a race for the private channel's sixteen concurrent
  calls and came back as "busy". The page now queues its P2P calls instead of
  firing them all at once, treats a busy answer as "a read is already in flight"
  rather than as a failure, and — if a read does fail — keeps showing the rows it
  has and says so beside them, instead of replacing a list the user can see with an
  error. Opening the page also reads immediately, so the list is there without
  waiting for the next announcement or pressing anything.
- A device list that is empty in one response can no longer arrive as a null list,
  which the shell refuses as malformed.

## 0.1.42 — 2026-09-15

- **The device list now has one owner, and it keeps itself current.** A network's
  device directory is read and held by the core instead of by whichever page
  happened to open it. Each page used to read the server for itself and keep its
  own copy, so two computers in one network could show two different member lists
  and neither ever caught up — one listed only the other computer, the other only
  itself, its own row still reading "never reported", and only quitting and
  restarting the app produced the current list. Now, if this computer is already
  signed in when the app starts, its networks and their devices are **there on
  first launch** — no tab to open and nothing to refresh. The core reads the
  directory when the session is restored, after anything that changes who belongs
  to a network (registering, binding, leaving, creating or deleting a network,
  pairing), and every thirty seconds while a sign-in is active; when the content
  changes it tells the window, and every list on screen updates by itself. The new
  **Refresh list** control asks for a read right now if you would rather not wait.
- The Run tab finds paired computers by itself. The add-workbench menu reads the
  paired computers main keeps in its catalog, and only a P2P page had ever asked
  for them, so opening the Run tab first — or after a restart — showed "choose a
  LAN or SSH computer" with an empty LAN section even though the server held an
  active pair. The menu now asks for the pairs when it mounts and again every
  time it opens, so a computer paired after the app started appears without
  visiting another tab first.
- A device list read no longer loses the race with the page's other reads, and a
  directory that could not be read keeps the last rows instead of silently
  showing an empty network.

## 0.1.41 — 2026-09-15

- A first install reaches the official server. The handshake asks the coordinator
  a challenge and the shell accepts only the thirty-two character challenge shape,
  but the core had been minting that value from the id generator — which the
  twelve-character id change shortened to twelve. The shell then refused its own
  core's answer, so a new machine showed an empty server list, could not sign in,
  and was told nothing about why. The core now mints a real challenge, and the
  coordinator accepts both shapes, so a machine that has not updated yet still
  reaches it.
- A stored configuration this build cannot read is repairable from the page that
  reports it. A machine that upgraded from a release using the older identity
  scheme (ids of another length) kept a record every operation re-validates —
  including the removal of a single service — so the Connect card could neither
  read it, use it, nor drop it: it showed `p2p.catalog_invalid` beside a retry
  that could never succeed, the account page then had no server to sign in to,
  and the only way out was deleting files by hand. The card now says the record
  comes from an older release, offers to discard it, keeps both files beside the
  new one as `p2p-devices.json.legacy-<stamp>`, leaves the device key and the
  saved sign-ins alone, and provisions the built-in server again.
- The card no longer loses the failure it is reporting. The status line and the
  connections panel mount beside it, and their reads carry no service, so they
  landed in the catalog's own operation slot and overwrote a failed read with
  their success: the card then claimed nothing had been read, with no code at all.

## 0.1.40 — 2026-09-15

- A connected computer's workbench now opens. A paired computer that had
  connected successfully showed a green state and an empty page with a "connect
  first" message, because the address main held was never handed to the page that
  mounts it: the tab was waiting for a value that nothing supplied. The address is
  now asked for per connection attempt, and a tab whose attempt has been replaced
  is never handed the previous one.
- A failed connection says which side is wrong, and keeps the error code on
  screen. Every failure used to read the same, with copy that told you to retry
  the other computer's SSH tunnel — there is no tunnel between paired computers.
  The tab now distinguishes this computer not being set up, an unreachable
  coordination server, the other computer being offline, a network that cannot be
  reached, a workbench that did not start, and an authorization that is gone.
- The device id on the Connect card is this machine's real device id — the one the
  coordinator registers, the member list shows and every paired computer pins. The
  card used to show a locally generated number that identified nothing anywhere
  else, so copying it into a member list did not work. It is the same value the
  server reports for this machine, and it is available before any account is
  bound.
- A computer bound to more than one account reports its presence to the account
  signed in on it. The device identity kept naming the account the machine first
  enrolled under, so a machine that had since been added to a second account
  looked offline there while it was running, and "this computer's identity belongs
  to another account" was reported for a machine that belonged to both. The
  warning now appears only when the signed-in account's own device list — read
  from the coordinator — does not contain this machine.
- A device directory that includes a computer another account enrolled first no
  longer fails to read. The row's owning account was compared with the reader's,
  and a machine bound to two accounts carries the first one's name, so the whole
  member list was refused as a scope mismatch.

## 0.1.39 — 2026-09-15

- Identifiers are twelve characters, the length and alphabet of a hardware
  address, so a device id can be read out, typed and compared by a person. A
  device id is derived from the machine's key, which means one machine is one
  device for the life of the machine — across accounts, networks and
  re-enrollments — and the coordinator records which accounts a machine reports
  to instead of a single owner.
- The device id is shown next to the device name on the Connect card, in the
  open, with a copy button, and the network id and enrollment identifiers carry
  the same copy control instead of being selected by hand. The pairing
  fingerprint is the same twelve-character key id.
- This machine keeps one device identity. The device key was minted per
  enrollment, so every registration, every join and every re-enrollment became a
  different device: pairs, pins and catalog rows still referenced the identity
  that had just been replaced, the coordinator's list carried entries naming
  neither side of either machine, and both ends could wedge on the other's stale
  identity — the wedge the same release's other P2P fixes exist to unwind. The key
  now lives in the core's own store beside the data root, like a hardware
  address: one identity per machine, reused for every network and every account,
  and it survives losing the credential record, which is the usual way a machine
  silently became a new device.

## 0.1.38 — 2026-09-15

- A paired computer that re-enrolled no longer disappears from the other machine.
  When both devices re-enroll (each getting a new device identity), the local
  catalog still held the old pair as active, and every member sync tried to drop
  it — which the catalog's transition guard correctly refuses, wedging the sync
  on `p2p.revocation_required` forever: one machine could see the other, but not
  the reverse, and the tab never opened. A row the coordinator's list no longer
  carries is now recorded as revoked instead of dropped, so the catalog converges
  on the next sync while the loss stays visible on screen.
- Pairing survives the coordinator connection dropping. The core subscribed to the
  coordinator once, and a lost connection — a network change, a laptop sleeping, a
  coordinator restart, a half-open socket — ended the subscription for good:
  attempts and signals stopped arriving, nothing reconnected, and only restarting
  the application brought P2P back, while the shell went on showing a healthy
  device. The subscription is now supervised and re-established in-process with
  capped backoff, and a connect attempt made while it is down fails at once with
  `p2p.server_unavailable` instead of waiting out its deadline and blaming the
  transport.
- A pairing relationship whose authorization the coordinator issues again can be
  recorded again. A revoked computer is never revived by the catalog's guard, so
  re-pairing the same two devices — the repair path after a removal — could not be
  written at all and the computer stayed revoked. The revoked record is now
  retired in its own commit before the new authorization is recorded.
- A pair that names neither side of this machine no longer aborts the entire
  member sync. That leftover from a re-enrollment is skipped, so the read that
  writes pins and the catalog still runs; rejecting the whole reply for one stale
  entry is what left a machine permanently seeing only itself and answering no
  offers.
- Being removed by another device now stops the reconnect attempts. The two
  authorization refusals the core actually sends (`p2p.pair_unauthorized`,
  `p2p.network_revoked`) were missing from the terminal list, so a removed
  computer stayed listed as active and was re-attempted forever in silence.
- A runtime refusal keeps its reason. The peer handshake answered every workbench
  failure with one constant, and the management boundary then mapped every
  `runtime.*` code to `p2p.internal_error`, so "the tunnel is up but the desktop
  is not" had no readable cause anywhere. The refusal the runtime owner named now
  survives both hops.
- A workbench that died without the shell noticing is no longer reported as
  available: the owner re-reads the runtime state instead of answering from cache,
  so the peer is never handed an address that is already gone.
- The packaged smoke can no longer hang on a machine whose session is locked or
  whose desktop is disconnected. Its probes settled on renderer timers and frames,
  which such a session stops delivering, so the smoke stalled until the runner
  killed it; they now settle on microtasks and force their own layout, and every
  renderer round trip is bounded so a stall is reported where it happened.

## 0.1.37 — 2026-09-14

- A typed refusal from the core no longer kills the private channel. The frame
  decoder only admitted `p2p.*` error codes, so a refusal such as
  `runtime.port_in_use` failed decoding, closed the channel, and reached the user
  as a bare `p2p.protocol_mismatch` — taking every other core operation down with
  it until restart. The decoder now admits every family the core declares
  (`p2p.`, `managed.`, `launcher.`, `runtime.`, `remote.`), so the real reason
  surfaces and the channel survives the failure.

## 0.1.36 — 2026-09-14

- A failed sign-in, join or start now leaves the real error behind. Anything that was
  not a typed refusal collapsed into `p2p.internal_error` and the original exception was
  dropped, so a join that reached the coordinator and failed locally could not be
  diagnosed from the product. The reason is now written to `shell-diagnostics.log`
  beside the shell's own records, next to the core channel's own diagnostics.

## 0.1.35 — 2026-09-14

- The launcher now records why its private channel to the local core failed, in
  `core-diagnostics.log` next to the core's own state: the exact bytes the core sent
  for its handshake, whether the named pipe or Unix socket authenticated, what
  `core.version` answered, and the child's exit code. This is the difference between a
  core that never started and one that started and disagreed, which a bare
  `p2p.protocol_mismatch` cannot tell apart.

## 0.1.33 — 2026-09-14

- The private channel to the local core no longer closes when the core writes to
  stdout. Only the one-line handshake travels on that stream, so any other output was
  read as a protocol violation and the whole channel was dropped with
  `p2p.protocol_mismatch` — on Windows that surfaced as no device identity, no account
  state, and no way to sign in or out. Core output is now relayed only when
  `DSH_P2P_TRACE=1` is set.
- A failed core handshake now logs what the core actually answered, instead of failing
  silently, so a core that cannot start is distinguishable from one that answered
  wrongly.
- Diagnostics for the local core channel, on every platform: start the app with
  `DSH_P2P_TRACE=1` and the core's own stdout and stderr are relayed, together with the
  reason its handshake was refused. This is what identifies a core that failed to start
  instead of one that started and disagreed.

## 0.1.32 — 2026-09-14

- Devices in a network can be **removed** from the device list, and their pairs go
  with them: unbinding a device already invalidated its pairs on the server, but
  the launcher kept showing the dead pair until it happened to sync, so removing
  one device looked like it needed a second manual cleanup. The list is now
  re-recorded as soon as the removal succeeds, and the sync that does it no longer
  loses to a busy operation lock.
- A single pair can be **revoked** on its own, for when only that pairing should
  end and the device itself should stay. The warning is shown before the write,
  because revoking drops the session immediately and re-pairing never restores it.
- The device list no longer keeps rows the coordinator will **not authorize**: a
  refused member sync used to be logged and skipped, which left dead computers on
  screen (and filled the log) until something else happened to rewrite the list.
  It is now treated as the answer it is, and a transient busy lock is retried.
- A stale catalog row that named this machine as **its own peer** (an artifact of an
  older build) is dropped whenever the network catalog is rewritten, so such a row
  clears itself instead of lingering as a second, impossible "device".
- When this machine is **no longer a member** of the network you are looking at,
  the device list says so instead of leaving an unexplained gap. Removing a device
  only removes it from that network: its identity and session remain, which is why
  it can still read as online elsewhere. Revoking a device outright is a separate
  action and is not offered yet.
- The network you last chose is **remembered** (per account, on this machine
  only), so returning to the screen lands where you left instead of asking again.
  The memory never decides for you: it is used only while that network still
  exists and belongs to the same account, and only a choice you made is stored.
- A network is **selected for you when it is the only one**. The previous rule
  never selected anything, to avoid aiming an edit at the wrong network; with a
  single network there is nothing to guess, so the click is gone. Several networks
  still wait for an explicit choice and are never matched by display name.

## 0.1.31 — 2026-09-14

- The Launcher now runs **one background process** instead of two. The headless
  core that already holds your device credential and your device catalog also
  serves the whole peer protocol, so the separate peer helper is no longer
  started. Pairing, connecting and the remote workspace behave exactly as
  before; what changes is that a machine whose core cannot start reports P2P as
  unavailable rather than quietly running a second process that no longer
  exists. The preflight check now verifies the core binary the app actually uses.
- The same core now also runs **with no desktop session at all**: `dshkerd
serve` publishes its own private endpoint and answers the whole method table,
  `dshkerd dsh start|stop` runs the DSH Web child, `dshkerd status`, `pair`,
  `connect`, `proxy` and `service configure` are named commands over the same
  operations the app performs, and `call` reaches any published method with its
  refusal code printed verbatim. The app is unaffected: it still starts the core
  as its child. `npm run release:readiness` now builds the core and proves it
  answers as a headless host, and the installer workflow runs the same check on
  every platform it packages.
- The core also owns the Launcher's **own root registry** now, so there is one
  writer for the file that says where your Harness, plugins, presets and settings
  live. The file keeps its format and location, an existing install is read
  exactly as before, and a machine whose core cannot start reports its
  configuration as unavailable instead of writing it a second way.

- Your managed Harness installations are the **core's** now too. Registering a
  toolchain, cloning a Harness, switching its revision and starting it ask the core
  for one operation and keep only what it answers with, so a machine whose core
  cannot start reports these operations as unavailable instead of quietly running
  Git itself. The rules that protect a checkout — the pinned Git, the mirror, the
  worktree, and the refusal to follow a branch that moved or a tag that changed —
  live in one place instead of two, and behave exactly as before.
- Fixed a defect that stopped every **headless host** from hosting anything:
  `dshkerd dsh start` told the DSH child to read an overlay file it never created,
  so the child exited immediately (`runtime.child_crashed`) and the host had no
  address to give. The command that names the file now creates it — an empty
  overlay, the same one the desktop app writes for its own profile — while a
  patch you name yourself is left exactly as it is.

## 0.1.30 — 2026-09-14

- Paired computers are now connected **without being asked**, and stay that way.
  Connecting happens at startup for every active pair, a dropped connection is
  retried on its own (immediately at first, then with a widening delay), and waking
  the machine or regaining a network retries at once. Only losing authorization
  stops the attempts, and the refusal is kept so the reason stays visible. Switching
  between tabs never interrupts a connection: it belongs to the pair, not the view.
- A remote workspace keeps **the same address** when the connection drops and comes
  back. The gateway used to be created per connection, so every reconnect moved it to
  a new port and any browser tab left open on the old address went blank. It now
  belongs to the pair: the address survives a drop, a network change, a wake from
  sleep and even a restart of the other computer's DSH, and a tab recovers on its
  own. While no session is attached it still answers but proxies nothing. Only
  revoking the pair, or deleting its network, retires the address.
- A connection is no longer torn down by a brief interruption. WebRTC reports
  `disconnected` for a few lost packets, a changed network or a machine waking up and
  normally recovers within seconds; treating that as a failure meant every hiccup cost
  a fresh hole punch. A lost path is now given 20 seconds to recover, and a peer that
  stays away is still reported, with its reason, once that window passes.
- A reconnecting remote workspace no longer fails the moment it comes back. A message
  arriving in the instant between the connection opening and its identity being
  checked used to tear the whole connection down, which made roughly one reconnect in
  ten die immediately with “no direct path” and then quietly come back on a later
  attempt. The check now waits for itself; bytes are still only accepted once the
  peer's identity is verified.
- Your paired device credential now lives in the **native secret store behind the
  headless core** (macOS Keychain, Windows DPAPI) instead of an Electron-encrypted
  file. An existing credential from a previous version migrates itself once on first
  launch and keeps working; a core that cannot start falls back to the previous
  behavior instead of failing the app.
- Fixed a data-loss defect found during that migration: the macOS Keychain writer
  silently truncated any secret longer than 128 bytes and corrupted binary values.
  Secrets are now encoded and stored in chunks; no released version was affected.

## 0.1.29 — 2026-09-12

- A remote connection that succeeded through the **relay** no longer tears
  itself down: the selected-path check rejected any pair involving a relay
  candidate, so the first data-channel open on a relayed session was reported
  as “no direct path”. A relayed UDP pair is now accepted like any other, and
  ICE still prefers the direct path when one exists.
- Pairing signals no longer expire before they are delivered: offers and
  answers carried the lease's expiry as their own validity, which the
  receiving peer always rejected as expired. Each signal now carries a
  short, signal-scoped validity window.
- The first **two-machine session** is verified: a Mac drove the DSH Web
  runtime on a Windows host through the P2P stack over the live coordination
  server — connection, selected path, local gateway URL, and the remote DSH
  Web page loading through the tunnel.

- P2P connections now fall back to your deployment server as an **opaque relay**
  (TURN, RFC 8656) when no direct UDP path can be established. The server only
  forwards the end-to-end encrypted packet stream (DTLS/SCTP ciphertext) and can
  neither read nor inject the traffic; a network where neither a direct nor a
  relayed path works still reports `direct_unavailable`, honestly. A relay
  credential fetch that stalls (for example while the server restarts) can no
  longer stall other connections: the fetch runs outside the session lock and
  degrades to the direct path on failure.

## 0.1.28 — 2026-09-11

- A computer that is online in a shared network now appears in the Run route's
  “+ / 添加远程工作台” picker, and can be connected to. The Launcher built that
  list from the coordinator's device directory, which deliberately carries no
  device keys, so pairing was never recorded and the list stayed empty while the
  device directory showed the computer online. The list is now built from the
  pairing records, and the identifier sent to the coordinator is the remote
  device's id — the id it authorises a connection by.

- A failed remote connection now reports why. Every attempt used to be reported
  as “remote runtime unavailable”, so a network that cannot establish a direct
  path was indistinguishable from a remote machine that was not serving DSH.
  “No direct path” is now reported as such.

- Starting DSH Web no longer fails blindly when its fixed port is still held by
  a leftover DSH Web process, e.g. one left behind by an earlier crash or by a
  manual development launch. The Launcher detects the holder before spawning,
  stops a residual instance it recognizes as its own, and only refuses with a
  clear “port in use” message when another program holds the port.

## 0.1.27 — 2026-09-11

- Fixed the macOS application icon package so Finder and Applications display
  the complete multi-layer DSHKer icon instead of a broken or blurry fallback.

- Updating a managed plugin now converges its Launcher-owned clone to the
  fetched revision before checkout. Build residue can no longer brick an
  extension update or surface as a misleading core-launch failure.

- Fixed a blank Run page after the P2P security hardening. Electron 42 reports
  an omitted WebView session partition as an empty string; the strict policy
  now admits only that exact platform representation while continuing to reject
  arbitrary partition labels.

- Remote workspaces are created on demand. Run starts with Local only; click
  “+” and choose a computer from the LAN or SSH list to create and focus its
  non-closable tab. The picker is a bounded floating panel that lists ready
  workspaces first and keeps unavailable ones visible but disabled with their
  real status.
