# Verification

All automated data is synthetic. The supplied specification itself is not committed.

## Automated coverage

The suite exercises configuration failures, unknown field/function references, condition engines, visibility and collection bounds, weighted scores, gate prerequisites, illegal transitions, migration idempotency, shadow comparison, unknown lookups, property-based mapping/score checks, refresh conflicts, frozen amendments, proposal policy, prototype-pollution rejection and deterministic manifests.

Backend checks cover 100 two-connection lease races, expiry, renewal, worker contention, stale writes, immutable trace events, provenance links, 200-row idempotent imports, duplicates, control-total rejection, missing snapshot customers, persisted import recovery, restart recovery, outage retries, readback mismatch/circuit handling, exception ageing and LLM input minimisation.

CSV migration checks cover the 10-customer Bank 1 CSV package end to end: conversion of grouped files, quoted and non-ASCII values, date and flag normalisation, automatic tier 1 postcode repair, declarations left for people, release, atomic CBS load folders, CSV readback reconciliation, combined batch load files and idempotent re-import. They also cover file-level rejections (checksum, missing column, orphan rows, unterminated quotes), control-total holds, and each review fix: scope decisions keep validation exceptions, blanked refresh values, refreshes of exported records, amendment rejection returning to the prior state, transient exception resolution, batch settling after failures, trace filters before limits, load-step playbook fixes, field-level reconciliation errors, per-run circuit breaking, lease-break notices and failed-renewal traces. OneDrive checks run the full 10-customer migration with both the landing and CBS load folders inside a `OneDrive - Bank 2` folder. They show the landing folder is left byte-for-byte untouched and only complete delivery folders ever appear in the synced tree. They also cover: refusal of staging inside a synced folder or on another drive; refusal of a synced database; Excel lock files, conflict copies, recently changed and non-UTF-8 landing files; half-synced files caught by checksums; and landing-folder import over the API with path traversal rejected. Sync checks cover refusal of a synced database, 1,000 saves leaving only the database and journal files, interrupted writes leaving no residue, repeated deliveries never creating copies, and detection of `.crswap` and conflict-copy names.

API checks cover authentication, server-enforced roles, cross-origin rejection, session expiry, lease-token ownership and real PDF responses. Browser checks cover the complete import/edit/release/download flow, two-user lease contention, desktop/tablet layout, zero running animations and an axe scan of the exception workspace. The scan does not replace full WCAG 2.2 AA manual assessment of every screen.

Synthetic XFA packet injection, supported Unicode rendering, unsupported-glyph rejection and long-line wrapping have regression coverage. A generated Unicode PDF was rendered and visually inspected. This does not establish compatibility with the bank's actual XFA form.

## Performance

An initial local benchmark on Node.js 24.19.0 processed 1,000 synthetic records through ingest, validation and summary/CSV/ZIP export in approximately 10.4 seconds. Largest-record rule evaluation was approximately 4.8 ms p95 in Node. The benchmark uses an in-memory database and excludes live CBS delivery. It is not a browser or production performance certification. Re-run `npm run benchmark` for the current implementation and deployment.

## Outstanding acceptance evidence

- Old-application golden outputs and validation shadow parity, because no old application was supplied.
- Official form/viewer compatibility and all real bank product-specific rules and mappings.
- Live CBS delivery, independent readback and batch cutover totals.
- Test-tenant/SSO, retention, WORM audit storage, restore rehearsal and production concurrency/load testing.
- Approved-model evaluations and reviewed production shadow samples. Auto-apply remains disabled.
- Full keyboard/screen-reader and WCAG manual acceptance across generated product pages.
- Container execution, because Docker was unavailable during implementation.

There are no GitHub Actions workflows in this change. The checks are run locally and can later be connected to the organisation's approved CI.
