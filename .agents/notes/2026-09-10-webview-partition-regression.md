# WebView blank-page regression

- `will-attach-webview` on Electron 42 reports an omitted `<webview
partition>` attribute as `partition: ""`, not `undefined`.
- The P2P hardening added a strict partition allow-list that rejected the empty
  string, so the Run guest was cancelled before `did-attach-webview`; the DSH
  server still returned its normal redirect and the browser could open the URL.
- The policy now admits only the exact empty-string representation as the
  omitted/default session, while retaining rejection for arbitrary labels.
- Verification: local DSH announced `http://127.0.0.1:3088/`, the Run guest
  reached the DSH page after the policy fix, and `electron/main/security.test.ts`
  covers both omitted and empty-string forms.
- A paired LAN computer is represented by a main-owned catalog computer. Startup
  now performs the authoritative `pairs` read and re-reads that catalog, and the
  pairing panel does the same after its read, so the fixed Run tab appears without
  requiring the user to visit Remote connections first. With no registered pair,
  only Local is expected and no placeholder tab is created.
- Remote WebViews are now lazy: the Run route starts with Local only. Its “+”
  control opens separate LAN-computer and SSH-connection lists; selecting one
  adds exactly one managed tab. Existing tabs survive transport status changes;
  removal of the authoritative connection/computer clears its tab. This
  prevents a 20-machine fleet from mounting 20 guests at startup.
- The add-tab lists are rendered in a fixed-position, bounded floating panel so
  they cannot resize or clip the browser surface. Ready entries sort before
  disconnected, negotiating, failed, or revoked entries; unavailable rows stay
  visible with their authoritative status but are disabled. The panel closes via
  its close button, Escape, or outside pointer input and restores trigger focus.
