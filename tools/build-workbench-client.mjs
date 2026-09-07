import { access, readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--harness-root' || !isAbsolute(args[1])) {
  throw new Error('Explicit --harness-root <absolute-built-checkout> is required.')
}
const harness = args[1]
const declarations = {
  '@deepseek-ai/cordis': ['vendor/cordis/lib/types/index.d.ts'],
  '@deepseek-ai/dsh-api-session-controller/client': [
    'packages/api/session-controller/lib/types/client/index.d.ts'
  ],
  '@deepseek-ai/dsh-api-workspace-controller/client': [
    'packages/api/workspace-controller/lib/types/client/index.d.ts'
  ]
}
for (const values of Object.values(declarations)) {
  values[0] = resolve(harness, values[0])
  await access(values[0])
}
const source = resolve(root, 'packages/dshker-workbench-client/src')
const program = ts.createProgram([resolve(source, 'client.ts')], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  skipLibCheck: true,
  paths: declarations
})
const diagnostics = ts.getPreEmitDiagnostics(program)
if (diagnostics.length) {
  const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n'
  })
  throw new Error(formatted)
}
const common = {
  outdir: resolve(source, '../lib'),
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  metafile: true,
  sourcemap: false
}
// DSH loads client bundles as classic scripts through its module registry,
// not as native ESM. Match the public client preset's factory contract.
const results = await Promise.all([
  build({
    ...common,
    entryPoints: { client: resolve(source, 'client.ts') },
    format: 'cjs',
    banner: {
      js: 'window.__ModuleLoader__.load({ id: "@ankye/dshker-workbench-client", factory: (require) => { var module = { exports: {} }; var exports = module.exports;'
    },
    footer: { js: 'return module.exports; } });' }
  }),
  build({ ...common, entryPoints: { index: resolve(source, 'index.ts') }, format: 'esm' })
])
const result = {
  metafile: {
    inputs: Object.assign({}, ...results.map((item) => item.metafile.inputs)),
    outputs: Object.assign({}, ...results.map((item) => item.metafile.outputs))
  }
}
for (const name of Object.keys(result.metafile.inputs)) {
  if (/(?:^|\/)(?:tests?|fixtures?|mocks?)(?:\/|\.)|\.test\./i.test(name)) {
    throw new Error(`Test dependency in workbench payload: ${name}`)
  }
}
for (const output of Object.values(result.metafile.outputs)) {
  if (output.imports.length)
    throw new Error('Workbench bundle contains unresolved runtime imports.')
}
// Validate the emitted artifact, not just its TypeScript source: native ESM
// parses during build but breaks DSH's concatenated classic-script batches.
const registrations = []
runInNewContext(
  await readFile(resolve(source, '../lib/client.js'), 'utf8'),
  {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  },
  { timeout: 1000 }
)
if (
  registrations.length !== 1 ||
  registrations[0].id !== '@ankye/dshker-workbench-client' ||
  typeof registrations[0].factory !== 'function'
) {
  throw new Error('Workbench client did not register the exact DSH module factory.')
}
const client = registrations[0].factory(() => {
  throw new Error('Workbench client attempted an undeclared runtime import.')
})
if (
  typeof client.apply !== 'function' ||
  JSON.stringify(client.inject) !== '["sessions","workspaces"]'
) {
  throw new Error('Workbench client factory exports are incompatible.')
}
console.log(
  JSON.stringify({
    status: 'built',
    harness,
    outputs: Object.keys(result.metafile.outputs),
    productionInputs: Object.keys(result.metafile.inputs)
  })
)
