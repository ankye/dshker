# D33 exact-socket queue diagnostic

The frozen D32 diagnostic is terminal FAIL. Its complete first short attempt
shows a 26.208s pending actual UDP read despite 133 subsequent valid captured
nominations. Earlier admitted nominations had response errno 65; other attempts
show successful same-socket I/O after that errno. No OS/netpoll/privacy root cause
or production repair acceptance is claimed. D32 helper, runner and raw evidence
must remain unchanged.

The active OpenSpec D33 permits a separate ignored diagnostic overlay only.
Query Darwin SO_NREAD (head datagram data bytes), SO_NUMRCVPKT (datagram count)
and SO_RCVBUF (capacity) within the owned UDP RawConn.Control callback. The three
getters are non-atomic, non-consuming metadata; their kernel locks/hooks can
perturb timing. Keep explicit validity/error/unsupported and read-in-flight facts.
Never read SO_ERROR, peek/consume packets, change deadlines, network policy,
permissions or production/dependency source. One bounded observer sampler must
stop/join before the writer seals its footer and close acknowledgement.

Real UDP and race tests plus independent review precede the new single physical
diagnostic. All results are diagnostic-only, not an eight-hour, native-app or
release pass. Preserve unknown boundaries and every original failure. The source
digest remains frozen; planning Markdown is recorded separately in run inputs.

The coordinator is already upgraded and trusted-TLS/WSS/v2 checked at the exact
server artifact. No server replacement or account/credential mutation is needed
for this socket diagnostic. Native interaction remains unavailable while the
user's Mac is locked; no unlock or permission bypass is authorized.
