# Remote network information architecture

- The complete 我的网络 card now belongs to the 网络与账户 tab because it owns device identity, enrollment status, membership, and network actions.
- The 连接 tab keeps only SSH connection management. Network joining, enrollment, and account management are intentionally grouped under 网络与账户 so the connection list has one clear job.
- The visual fixture now mounts the real RemoteConnectionsPanel; focused tests cover the tab placement and verify that the Connect pane has no network-join card.

# Remote tab accessibility and network cards

- An active pair without a live session is `available`, not `disconnected`; the add-tab menu uses the accent color for that actionable state and reserves red for actual failure, revocation, or offline status.
- The teleported add-tab dialog now enters focus on open, loops keyboard focus, activates buttons with Enter, closes with Escape, and restores focus to the trigger after dismissal or selection.
- Network management uses labelled cards with explicit name, device-limit, selection, and management fields. Network IDs are folded into technical details with a copy action and join explanation.
- The joined-device card now keeps device name, device ID, joined network ID, copy actions, and Leave network in one visible hierarchy. New credentials retain the network ID; legacy credentials state when it is unavailable rather than deriving a network from an account list.
- The local identity and disabled sign-in/register shell remain mounted while the coordinator is not ready. Legacy network IDs are recovered only from one authoritative catalog match; a renderer HMR reload now retains a monotonic P2P request sequence so the main-process replay guard does not reject the next catalog read.

# Network account hierarchy and state copy

- The account page now presents one clear state and next action: the identity card keeps the device name, device ID, joined network ID, copy actions, and Leave action; a joined signed-out device reads `已加入 · 未登录`, and the account panel asks the user to sign in to manage networks and paired devices.
- The coordinator presence badge is labelled `服务在线/离线/状态未知`; this keeps service-session presence distinct from a remote device's P2P connection state.
- Busy refusals (`p2p.helper_busy`, `p2p.service_busy`, and `p2p.connection_busy`) are neutral account-reading feedback. Other refusal codes remain available under collapsed diagnostics rather than being exposed as the primary red product copy.

# Network account workspace simplification

- The signed-in account workspace no longer exposes account technical IDs or repeats the local enrollment/recovery and pairing panels. Those are implementation/diagnostic domains, not the primary network-selection task.
- Networks are selected from one labelled listbox. Create network sits beside that selector and opens a modal; rename, capacity, network ID, and deletion are grouped in a separate management modal.
- Selecting a network shows its name, ID, limit, and member directory. The existing connection and device domains remain available; only their duplicate account-page presentation was removed.
- The visible copy follows a shorter title chain (`Networks and devices` → `Networks` → `Devices`); the signed-in label is compact, and the selected network name is no longer surrounded by repeated “my/current/network” wording.
