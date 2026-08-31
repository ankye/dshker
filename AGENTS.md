# DSH Launcher

DSH Launcher is an independent Electron application registered as the
\`desktop_workspace/apps/dsh-launcher\` submodule. It manages DeepSeek Harness
installations without embedding a Harness checkout in the application package.

## Ownership

- \`electron/\` owns main-process lifecycle, typed IPC admission, native dialogs,
  custom protocol registration, secure-provider mediation, and child-process
  supervision.
- \`electron/preload.ts\` owns the frozen renderer capability surface.
- \`src/\` owns renderer presentation and product domains.
- \`src/shared/\` owns cross-process TypeScript contracts only.
- \`src/foundation/\` owns renderer adapters, never product workflows.
- \`src/app/domains/<domain-id>/\` owns each product workflow and exposes it from
  its public \`index.ts\`.
- \`packages/desktop-foundation/\` owns reusable, app-neutral helpers. Product
  code must not import its private files.
- \`service/node/\` is not a production runtime. The inherited VFS service is
  deliberately disabled and must not be reintroduced as a launcher transport.

## Required behavior

- Missing roots, tools, files, protocols, profiles, bridge versions, or persisted
  records fail with a typed error. Do not infer, default, or substitute a value.
- The renderer never receives arbitrary filesystem, shell, Git, subprocess,
  credential, or dialog access. Add a named typed operation only after updating
  the OpenSpec and its admission tests.
- Production resources use \`dsh-app://\`; do not restore a \`file://\`,
  loopback-Web, SDK-stdio, global-\`dsh\`, or WebWorker fallback.
- Keep managed Harness source, plugins, configuration, settings, and data in
  separately registered roots. Do not implement root selection with a hidden
  app-data default.
- Keep mock, fixture, simulator, and test-support code out of production entry
  points and packaged artifacts.
- Route renderer-visible product copy through typed locale dictionaries.

## Validation

Run relevant checks from this repository:

\`\`\`bash
npm run environment:check
npm run format:check
npm run architecture:check
npm run type-check
npm test -- --run
npm run service:smoke
npm run visual:smoke
npm run build
npm run build:electron

# Run this one from the desktop_workspace repository root.

node tools/validate-desktop-app.mjs --app apps/dsh-launcher --json
\`\`\`

For any non-trivial product, IPC, persistence, or release change, update the
active OpenSpec change and add an Agent Note under \`.agents/notes/\`. Do not
commit generated output, local roots, credentials, signing material, or release
artifacts.
