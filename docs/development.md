# Development

Run from the launcher repository:

\`\`\`bash
npm ci
npm run environment:check
npm run type-check
npm test -- --run
npm run build
npm run build:electron
\`\`\`

The Electron main process owns native authority. Renderer code may use only
typed methods exposed from \`electron/preload.ts\`. It must not infer a local
path, read a secret, call a shell, or select a fallback Harness runtime.

The current foundation intentionally renders a blocked setup state. Use the
active OpenSpec tasks before adding root persistence or an IPC operation.
