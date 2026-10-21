# Windows inherited PATH terminator

The Windows launch preflight reported `The inherited PATH contains an empty
entry.` for a PATH that ended in its conventional single semicolon. The shared
PATH parser split that terminator into an empty element and rejected launch
before DSH started; the failure was visible in Launcher Console, not the child
`dsh-web.log`.

The resolver now removes only one final delimiter from the Windows inherited
PATH. It continues rejecting a leading empty entry, any interior empty entry,
and an additional empty entry from repeated terminal delimiters. A delimiter-
only PATH remains invalid even if the bundled runtime path is present, so the
fix does not introduce a guessed path, current-directory search, or fallback.

README guidance was checked and remains accurate; it documents the standalone
`dshkerd` install directory rather than DSH Web command PATH composition.
