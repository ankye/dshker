# One device id per machine, and the account it reports to

Date: 2026-09-15

## What prompted this

The product now treats a device id as a property of the machine — like a hardware
address — that can be bound to several accounts. The client was still built around
the older assumption that a machine belongs to exactly one account, and the
mismatch showed up in three places a user can reach:

1. The 「我的网络」 card showed the machine's own id, and that id was a random
   number minted into the settings root. It looked like an identifier but named a
   device no coordinator, member list or peer had ever heard of, so the value the
   product asks the user to copy out could not be compared with anything.
2. Signing in as somebody else produced "this computer's identity belongs to
   another account" whenever the local credential's account differed from the
   signed-in one. The credential records the account the machine _first enrolled
   under_; a machine added to a second account's network by hand keeps that value
   while working perfectly for the second account, so the card accused a working
   machine.
3. A machine that is bound to two accounts only ever reported presence to the
   first one, because the device identity handed to the core named the credential's
   account. The second account saw a running computer as offline.

## What changed

- **The local device id is the machine key's id.** `localDevice` now asks the core
  for this machine's device key and derives the id exactly as the coordinator does
  (`sha256(public)[:6]`, hex). `peerDeviceId` is the one place that rule lives, and
  the pairing fingerprint is its grouped form; the random `p2p-local-device.json`
  file is no longer written or read.
- **The account's own device list decides belonging.** A new read,
  `accountDevices` (`devices.list` for the signed-in account), is the only thing
  that can answer "does this machine belong to the account signed in here?" The
  card reports a foreign identity only when that list has been read and does not
  contain this machine; an unread list claims nothing.
- **Presence is reported to the account that is signed in.** Before restoring the
  device into the core, the shell asks whether the signed-in account is bound to
  this machine; when it is, the device identity names that account instead of the
  credential's. The coordinator itself refuses an account the device is not linked
  to (`p2p.device_unauthorized`), so the check happens before the heartbeat rather
  than being discovered by a refused one.
- **A device directory row is no longer compared with the reader's account.** The
  row's own `userId` is the account that first enrolled the machine, while the
  directory is already scoped to the reader; comparing them made a two-account
  machine's whole member list unreadable with a scope mismatch.

## Evidence

- `electron/main/p2p/local-device.test.ts` — the reported id is the key's id, and
  two reads of an unmoved key agree.
- `electron/main/p2p/accounts.test.ts` — a row another account enrolled first is
  read, an impossible presence is still refused, the account's device list is read
  with the session token, and the signed-in account is reported for the device
  identity.
- `src/app/shell/tests/P2PJoinPanel.test.ts` — no claim before the account's list
  is read; a conflict only when the machine is absent from it; nothing when it is
  present.

## What is still open

The coordinator's `devices.list` is read once per sign-in and per registration; a
binding added while the panel is open (an owner binding this device from their own
machine) is not noticed until the panel is reopened. That is a refresh question,
not a correctness one: no surface claims anything it has not read.
