/**
 * What the launcher log says when a launch fails.
 *
 * Only the public refusal code crosses the private channel, so the operator's log
 * used to repeat the code and nothing else: "DSH Web process could not be
 * created: runtime.port_in_use" named neither the cause nor the fix, and the
 * question it raised — is my port taken, and by what? — had to be answered by
 * hand. The codes whose remedy is not obvious from their name get a sentence.
 */
const REMEDIES: Readonly<Record<string, string>> = {
  'runtime.port_in_use':
    'The listen port is held by another process. That is usually a DSH Web left over from an earlier run; stop it, or choose a different port in Settings, then start again.',
  'managed.harness_port_in_use':
    'The listen port is held by another process. Stop it, or choose a different port in Settings, then start again.',
  'runtime.child_crashed':
    'The DSH Web process exited during startup. Its own output above says why; a missing build or a failed plugin load are the usual causes.'
}

/** The launcher-log line for one failed launch, with the remedy named when known. */
export function launchFailureEventText(code: string): string {
  const remedy = REMEDIES[code]
  return remedy === undefined ? code : `${code} — ${remedy}`
}
