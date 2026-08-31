# Navigation

Use this folder for app-layer route definitions and navigation helpers shared by
Electron and Web hosts.

Rules:

- Navigate by route id and route target, not by ad hoc string paths in
  components.
- Keep the route table host-independent. Electron deep links and Web URLs are
  adapters over the same route ids.
- Cross-domain navigation should target another domain's public route id, not a
  private view component path.
- Use hash navigation for packaged Electron surfaces and history navigation for
  browser-hosted Web surfaces. The host runtime selects the mode.
- Keep URL state serializable. Put ids, filters, cursors, and view options in
  query parameters; do not put mutable objects or local file-system paths in a
  navigation target.
- Domains request navigation through shell-owned commands or events. Domain
  components should not call `window.location`, Electron protocol APIs, or
  browser history APIs directly.
- Listen to shell route-change state for reverse refresh. Back/forward buttons,
  deep links, and web share URLs should update the same route state that menu
  clicks update.

Recommended route ownership:

- `src/app/shared/navigation/routes.ts` owns route ids, paths, host visibility,
  and shareability.
- `src/app/shell/` owns the actual navigation side effect.
- `src/app/domains/<domain-id>/index.ts` can export public route ids for the
  domain, but private view component paths remain internal.
