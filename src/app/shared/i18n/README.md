# App I18n

This folder owns app-layer localization for generated desktop apps.

- Keep supported locales and message keys in `i18n.ts`.
- Route labels, shell chrome, and user-facing settings should use message keys.
- Product domains can add domain-specific message files, but the shell should
  compose them through one public i18n entrypoint.
- Missing translations intentionally fall back to the key so development gaps
  are visible in tests and previews.
