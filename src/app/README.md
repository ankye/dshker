# App Layer

Product behavior lives under `src/app/` and is organized by business domain.
The root renderer entry files stay thin; they compose the app shell and delegate
product behavior to domain folders.

Required areas:

- `shell/` owns app composition, navigation, workspace layout, route wiring, and
  shell-only state.
- `domains/<domain-id>/` owns product behavior for one business domain.
- `shared/` owns app-layer helpers, small shared UI pieces, and types reused by
  multiple domains.
- `shared/messages/` owns cross-domain event and command contracts.

Move reusable framework behavior to `packages/desktop-foundation/`. Keep
product-specific providers, workflows, records, copy, screens, and adapters in
`src/app/domains/<domain-id>/`.

Domains should avoid direct dependencies on each other's private state,
repositories, workflows, and components. Use another domain's public `index.ts`
for explicit APIs, and prefer typed events or commands for coordination.
