# A refused member sync no longer leaves dead computers behind

Date: 2026-09-14
Change: `go-owned-headless-core` (P6) — remote-connections internals

## What was wrong

The catalog the Run tabs and the device list render is rewritten from the
coordinator's pair list on every read and on the periodic sweep. Two things kept
that rewrite from landing:

1. The sweep collided with a concurrent read on the per-service operation lock
   (`p2p.service_busy`) and gave up for that cycle.
2. When the coordinator refused the pair list because this machine holds no
   authorized pair (`p2p.pair_unauthorized`), the refusal was logged every few
   seconds and the catalog was left exactly as it was -- so rows for pairs the
   coordinator would never authorize stayed on screen, and the log filled with the
   same stack.

## What changed

- `#refreshMembers` retries once on `p2p.service_busy` (a lock collision is
  transient).
- A refusal that means "no authorized pair" is now treated as an answer: the
  catalog is rewritten empty for that service, the code is logged once instead of
  per sweep, and the next successful sync clears the marker. Nothing is swallowed:
  the code is visible in the log and the rows disappear because the coordinator
  has no pairs, not because the launcher hid them.
- `#recordMembers`, `remoteSide` and their helpers moved to `member-catalog.ts` so
  `management.ts` keeps room to change (1010 → 941 lines before this fix, 964
  after it).

## Evidence

- p2p suite: 25 files / 380 tests, `type-check`, `format:check` and
  `architecture:check` clean.
- The refusal path is exercised through the existing member-sync cases; a case
  that seeds a self-pair record and asserts it is dropped on rewrite is still to
  be written.
