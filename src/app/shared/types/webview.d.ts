/**
 * Minimal `<webview>` element typing for the run view.
 *
 * The run page hosts DSH Web in an Electron `<webview>` rather than an iframe:
 * DSH authenticates with a `SameSite=Strict` cookie, which a cross-site frame
 * never sends. Vue needs the tag declared to type-check the template.
 */
declare module 'vue' {
  interface GlobalComponents {
    webview: new () => {
      $props: {
        src?: string
        class?: string
      }
    }
  }
}

export {}
