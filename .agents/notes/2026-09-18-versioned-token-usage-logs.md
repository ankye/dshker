# Versioned token usage logs — 2026-09-18

## Symptom

Token statistics showed `无法读取的会话数 32`, and the recent-7-day view did
not contain current records.

## Cause

The reader enumerated every session directory but always opened
`session.jsonl.zstd`. DSH now keeps versioned files in those directories:
`session.v2.jsonl.zstd` and `session.v3.jsonl.zstd`. The versioned files were
valid zstd/JSONL logs; their missing legacy path was what created the false
unreadable count. Some directories retain multiple generations, so reading all
files would double count the same session.

## Repair

- Discover `session.jsonl.zstd` and any `session.vN.jsonl.zstd`.
- Read only the highest version present in each session directory.
- Count only actual read/decode failures as unreadable; do not subtract the
  paginated detail list length.

## Validation

- Focused reader suite: 20/20 passed.
- Real local `.dsh` readback: 85 sessions, `unreadableSessions=0`, newest daily
  usage date `2026-09-18`.
- Added fixtures for legacy/v2/v3 coexisting files and a genuinely corrupt log.
