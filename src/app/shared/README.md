# App Shared

Use this folder for app-layer helpers that are shared by two or more domains but
are not reusable framework code.

Allowed examples:

- small presentational components
- app-specific view models
- app-specific formatting helpers
- app-specific localization catalogs
- product-level constants with no secret values

If a helper becomes generic across desktop apps, move it to
`packages/desktop-foundation/` with tests.
