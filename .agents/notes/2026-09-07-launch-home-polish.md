# Launch home visual refinement

The user requested smaller, more intentional hero copy and a less heavy interface. Retained the otter identity and three-card hierarchy. Hero uses a 24–30px localized welcome heading rather than a 48px product-name billboard, with a small brand label, concise 13px supporting text and 208px height. Muted theme-derived surfaces and outlines reduce card weight; source actions are text rows, version/check actions are compact outlined buttons. Commit uses a 12-character summary with full title/accessibility label.

Evidence: 22 focused tests, Electron build, real renderer screenshots and native resize measurements at 744x495, 1224x755 and 1584x935, and public version-navigation click. Art and title remain separate. No behavior, IPC, update source, or global-theme changes. Existing dirty layout/brand work preserved. Diagnostic evidence is under .run/launch-home-layout; no packaged-release or performance-ledger acceptance is claimed.
