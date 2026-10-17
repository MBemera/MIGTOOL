# Implementation and integration status

This repository started with a README and licence. There was no existing React application to migrate, no authoritative bank mappings and no historical output set. The supplied confidential specification is not copied into this public repository.

## Module coverage

| Module           | Implementation                                                                                                                           | Boundary                                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M01 Config       | YAML parsing, Zod meta-validation, condition compilation, references, hashes and linting                                                 | Meta-schemas are implemented in TypeScript using Zod.                                                                                                                   |
| M02 Record model | Generated TypeScript shape, runtime validators and reviewed migration registry                                                           | Includes an illustrative v73 demo upgrade. Real schema migrations need review.                                                                                          |
| M03 Conditions   | Shared JSONata, JSONLogic and named checks                                                                                               | Configuration is trusted code reviewed through pull requests.                                                                                                           |
| M04 Rules        | Required/type/option checks, weighted rules, visibility and shadow comparison                                                            | No legacy validator was available for parity verification.                                                                                                              |
| M05 Gates        | AAF/CBS prerequisites, blocking severities and enforced transitions                                                                      | Demo thresholds require bank approval.                                                                                                                                  |
| M06 Mappings     | Shared transforms, lookup errors, ingest/output bindings                                                                                 | Current columns and code tables are synthetic.                                                                                                                          |
| M07 Projections  | PDF summaries, CSVs, deterministic ZIPs and manifests; XFA packet writer                                                                 | `aaf.pdf` is explicitly a review summary. Official XFA template/bindings are required to replace it. No old-tool golden equivalence is claimed.                         |
| M08 Ingest       | Persisted source input, atomic batch processing, duplicate detection, provenance and control totals                                      | Current landing format is UTF-8 JSON. Real CSV/extract adapters need their format contract.                                                                             |
| M09 Refresh      | Conservative three-way merge, collection conflicts, source-missing flags and frozen post-load data                                       | Repeating groups without stable item IDs use whole-group review when human-edited.                                                                                      |
| M10 Storage      | Central HTTP service over local SQLite WAL, conditional versions                                                                         | Backend route chosen for DEC-01. No Graph or synced-folder adapter is enabled.                                                                                          |
| M11 Leases       | Atomic acquisition, renewal, release, server expiry and admin break                                                                      | Human leases default to 15 minutes; worker leases to 5 minutes.                                                                                                         |
| M12 Workflow     | Persisted import work and delivery queue; export/load/readback checkpoints                                                               | SQLite is the local durable orchestration engine. A crash rolls back an incomplete import and the saved input is replayed.                                              |
| M13 Triage       | Exception classes, approved formatting playbook, retry caps and circuit breaker                                                          | Operational errors are routed to humans when no applicable automatic path is enabled. Holiday-aware review SLAs and external incident delivery remain integration work. |
| M14 Steering     | Injected approved-model contract, field minimisation, strict proposal schema, scope/protected-field checks, two attempts, shadow logging | No external transport is configured. LLM auto-apply is disabled. Evaluation against bank-approved data and model approval are outstanding.                              |
| M15 Reconcile    | Persisted simulated readback, export row counts and extract-baseline drift detection                                                     | Live CBS acknowledgements, independent readback and full cutover control totals need the actual interface.                                                              |
| M16 Trace        | Append-only database events, record/config versions, hashes, provenance references and queries                                           | SQLite triggers protect application writes. External WORM retention, backups and retention policy require deployment decisions.                                         |
| M17 Access       | Password hashing, sessions, roles, origin checks and login rate limiting                                                                 | SSO, password recovery and organisation-wide account lifecycle are not integrated.                                                                                      |
| M18 UI           | Generated forms, exception register, dashboard/PDF, records, batches, admin and trace viewer                                             | Win95 style, blue/white/black, no animations. Playbook promotion downloads a review draft; it does not automatically open a GitHub PR.                                  |

## Inputs required for live integration

1. A redacted sample extract, data dictionary, stable customer ID and repeating-group IDs; confirm full-snapshot versus incremental refreshes.
2. The real form schema, business rules and approved product configuration for each product.
3. The official AAF v73 XFA template, amendment template and approved node bindings.
4. CBS output specifications, delivery protocol, idempotency/acceptance rules, acknowledgements and readback format.
5. Approved storage/deployment topology, SSO choice, retention, backup and access requirements.
6. An approved model deployment and data-handling terms if steering is enabled; labelled evaluation and reviewed shadow results before any class becomes eligible for auto-apply.
7. Historical outputs and fixtures from the old application to establish golden equivalence and Phase 0 baselines.

## Boundaries

The application never sends customer data to an external AI endpoint. The shipped CBS adapter is a local simulation. The app cannot make a real bank load. No live-system credentials are included.

The PDF summaries include an explicit synthetic-pack notice. Unicode covered by the bundled DejaVu Sans fallback is retained; unsupported glyphs block output rather than silently changing a name. Additional scripts may require a bank-approved font.

The XFA adapter supports packet-array templates with a datasets packet. It is tested against a synthetic template. Single-stream XDP templates are rejected. The real form must be verified in its approved viewer before release.

A schema change can be checked with `npm run check:config -- --compare path/to/previous/config`. Run `npm run revalidate` after an approved release to migrate/revalidate open records under leases. Exported and loaded records remain frozen.
