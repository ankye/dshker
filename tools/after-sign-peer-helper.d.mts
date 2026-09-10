/**
 * Types for the packaging hook so it can be tested from the TypeScript project
 * without pulling all of tools/ into type checking.
 *
 * Named .d.mts because TypeScript resolves declarations for an .mjs module by
 * that extension; a plain .d.ts is not consulted.
 */
export interface AfterSignContext {
  readonly appOutDir: string
  readonly electronPlatformName: string
  readonly packager: { readonly appInfo: { readonly productFilename: string } }
}

export default function afterSign(context: AfterSignContext): Promise<void>
