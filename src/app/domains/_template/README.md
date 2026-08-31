# Domain Template

Copy this folder when adding a new product domain, then rename it to a
kebab-case domain id.

Use the smallest useful structure:

- `index.ts` for the public API.
- `contracts.ts` for domain records, commands, events, and validation types.
- `views/` for route-level screens.
- `components/` for domain-only components.
- `state/` for domain stores and derived state.
- `workflows/` for long-running use cases and process orchestration.
- `repositories/` for typed persistence over framework storage or VFS adapters.
- `adapters/` for product-specific provider, parser, or bridge integration.
- `tests/` for domain unit, component, and E2E fixtures.

Delete unused folders in the real domain. Do not add generic framework helpers
here; put those in `packages/desktop-foundation/`.

Coordinate with other domains by publishing typed events or commands. Do not
reach into another domain's private folders.
