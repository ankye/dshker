# Domain Modules

Create one folder per business domain:

```text
src/app/domains/<domain-id>/
  index.ts
  README.md
  contracts.ts
  views/
  components/
  state/
  workflows/
  repositories/
  adapters/
  tests/
```

Only create subfolders that the domain actually needs. Keep related UI, state,
workflow, persistence, provider, and validation code together in the domain
folder so product behavior remains easy to move, test, and delete.

Rules:

- Use kebab-case folder names, for example `asset-library` or `render-queue`.
- Export the domain public API from `index.ts`.
- Cross-domain code must import another domain through its public `index.ts`.
- Do not import another domain's private `views/`, `state/`, `workflows/`,
  `repositories/`, `adapters/`, or component files directly.
- Prefer domain events and commands from `src/app/shared/messages/` for
  cross-domain coordination.
- A domain may publish facts about its own state, but it must not mutate another
  domain's store or repository directly.
- Keep shared cross-domain primitives in `src/app/shared/` only when they are
  product-specific.
