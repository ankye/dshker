## Login feedback and network discovery

### User goal

After valid credentials are accepted, the account view should become usable
without waiting for the coordinator's network list. The list still must load
automatically, and a failed read must remain truthful and retryable.

### Interaction contract

- Authentication: ready → submit → main-process authentication and secure
  persistence → signed-in identity settled. The password input is cleared on
  submit and no secret enters renderer state.
- Network discovery: independent loading state owned by the network region;
  success replaces the list, failure preserves an existing list or shows an
  explicit unread state, and Retry starts one explicit read. A failure never
  clears a confirmed user or becomes an account-level login error.
- Busy/helper refusals remain neutral because another read is authoritative in
  flight; the existing operation status remains visible.
- Existing session readback (`user.current`) and secure persistence are retained
  as authentication prerequisites. No fallback identity or guessed network is
  introduced.

### Implementation and evidence

- `P2PAccountsDomain.login/register` publish the accepted user before starting
  the recoverable network read.
- `P2PAccountState.networksError` preserves typed list failures for the network
  section; existing rows are not discarded on a failed refresh.
- `P2PAccountPanel` separates network loading copy from account errors and
  exposes an accessible retry control with diagnostics.
- Regression coverage: slow network read keeps the signed-in view mounted;
  network failure shows a local retry state; existing account and directory
  suites remain green.
