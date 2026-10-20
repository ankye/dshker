# Direct stable publication requested by the user

The user explicitly requested direct publication after the remaining physical
long-duration and native gates had been reported incomplete. The release is the
current production candidate, version 0.1.91, with a documentation-only follow-up
to source commit 4848983. The original candidate's exact-SHA Quality and Package
workflows passed; the new tag must still pass its own unchanged GitHub source,
native desktop, standalone CLI and assembly jobs before publication is called
complete. Do not build installers locally, reuse a version/tag, overwrite assets
or substitute diagnostic overlays.

The bilingual CHANGELOG entry explicitly preserves intermittent Mac-Windows ICE
failure, incomplete eight-hour/native verification and outstanding macOS local
network metadata/signature-sealing work. Both READMEs already describe the missing
physical gate and remain accurate. Unsigned manual-install distribution is the
existing channel, not a newly introduced signing substitute or notarization claim.

This instruction changes publication sequencing, not evidence. The repair goal,
failed physical cases, unfinished D33 collector review items and native acceptance
remain open. No account, device, network, pair, credential, system policy or
production server is changed by this release action. The standalone coordinator
upgrade has its separate retained verification record.
