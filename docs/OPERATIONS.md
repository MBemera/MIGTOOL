# Operations

## Process and storage

The server serves the built React interface and authenticated API on port 3001. It also runs one delivery-queue loop. `npm run worker` can run an additional worker against the same local SQLite database; leases and conditional writes prevent interleaved edits. All processes must use the same configuration release.

Use local persistent disk for SQLite. Do not place the database, WAL or shared-memory file inside OneDrive, SharePoint sync, a network filesystem or an ephemeral container layer. The server, worker and scripts refuse to start when the database, CBS load folder or batch export folder is inside a sync client folder (`OneDrive`, `OneDrive - <org>`, `SharePoint`, `Dropbox`, `Google Drive`, `iCloud Drive`, or the paths in the `OneDrive*` environment variables). This backend is intended for one host. A multi-host deployment needs a database adapter with equivalent transaction, lease and version semantics.

Imports are committed as a batch transaction. Input is durably queued first, so an abrupt process failure leaves a replayable import. The local synchronous engine can occupy the request process during large imports. Production load and the two-second lease-visibility target need verification on the actual deployment, or imports should run in a separate service with an appropriate database.

The queue stores each record's stage in the record plus output hashes and idempotent acceptance receipts. A process that dies while holding a lease waits for server-time expiry before another holder can proceed. Delivery jobs become reclaimable after five minutes.

## Environment

| Variable                     | Purpose                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `HOST`                       | Defaults to `127.0.0.1`. Explicit demo refuses a public bind.                             |
| `PORT`                       | Defaults to `3001`.                                                                       |
| `DATABASE_PATH`              | Normal workspace database, defaults to `var/migtool.sqlite`.                              |
| `MIGTOOL_ADMIN_USER`         | Initial admin username, defaults to `admin`.                                              |
| `MIGTOOL_ADMIN_PASSWORD`     | Required on the first normal start; minimum 12 characters.                                |
| `APP_ORIGIN`                 | Exact browser origin allowed for mutations. Set the HTTPS origin for a shared deployment. |
| `NODE_ENV`                   | Set to `production` for secure cookies behind HTTPS.                                      |
| `MIGTOOL_DEMO_DATABASE_PATH` | Optional isolated demo/test database location.                                            |
| `CBS_OUTBOX`                 | Bank 2 CBS load folder. Defaults to `cbs-outbox` beside the database.                     |

Initial administrator variables only bootstrap an empty user database. Changing them does not rotate an existing account password. Do not run demo mode against real data. `.env` and all databases are ignored by git.

The default operating thresholds live in `config/operations.yaml`, are validated at startup and are included in configuration fingerprints. Human renewal runs every five minutes while active. The UI warns at 25 minutes and releases after 30 minutes of inactivity. Drafts remain in session storage for that user and tab. A stale draft retains its original ETag, so it cannot silently overwrite a newer version.

## Temp files, duplicates and sync conflicts

The original tool's sync faults (section 10.1 of the specification) cannot occur on these paths:

- **One authority per record.** Records, leases and traces live in one SQLite database written in transactions. Two editors are stopped by atomic leases, and stale saves are rejected by version checks. Nothing is written through a sync client or the browser File System Access API, so no `.crswap` files are created.
- **Load folders appear complete or not at all.** Every delivery is built in `<outbox>/.staging/<id>/`, flushed to disk, then renamed into place in one step. A crash part-way leaves only staging, which is deleted at start-up. Readers and the CBS loader must ignore dot-folders.
- **No overwrites, so no conflict copies.** Re-delivering identical content is a no-op. Different content under an existing name is an error, never a second copy. Folder names include the record's output hash, so a changed record gets a new folder.
- **Detection.** `/api/health` reports `strayFiles` for the load folder: temp files, staging leftovers and conflict-copy names such as `name (1).csv` or `name-DESKTOP-ABC.csv`. Anything above 0 needs investigation.

Browser drafts stay in the tab's session storage and are never written to disk.

## Containers

```sh
docker build -t migtool:local .
docker run --rm -p 127.0.0.1:3001:3001 --env-file .env \
  -e NODE_ENV=development -v migtool-data:/data migtool:local
```

The example is a loopback HTTP deployment. For shared use, terminate HTTPS, set `NODE_ENV=production` and `APP_ORIGIN` to the exact HTTPS origin, and restrict network access. The container uses a non-root user and a health check. The Dockerfile has not been built in the authoring environment because Docker is unavailable there.

## Release checks

Run the commands in README on a clean `npm ci`. Validate configuration, review fixture impact, test the real bank output templates and run user acceptance in a test environment. No production acceptance or compliance certification is implied by the local suite.

Back up using SQLite's online backup mechanism or stop every process and copy the complete database state. Test restoration before deployment. Establish retention for extracts, drafts, outputs, receipts and traces under the organisation's policy.

## Operational actions

- A failed control-total check holds the batch before any record is imported. Correct the source and import again; this hold cannot be bypassed with Resume.
- Release Ready queues eligible records only. Records with conflicts or unresolved scope flags are excluded.
- A batch with remaining input gaps returns to Ready after eligible jobs finish. Completed means every accepted member is reconciled or withdrawn, with no rejected source rows.
- An approved playbook fix acquires a worker lease, checks the patch policy and revalidates. Existing exception age and assignment are preserved when the issue remains unresolved.
- A refresh of an exported, loaded or reconciled record stages proposed data, provenance and baselines as an amendment. Reviewer edits and approval do not modify the frozen data until CBS delivery and readback succeed. Rejecting an amendment returns the record to the state it was in; an unfinished delivery resumes.
- Failed delivery jobs are triaged by class: transient errors retry (tier 0), CBS rejections with an approved load-step playbook entry are fixed once and reloaded (tier 1), data errors go to operators (tier 3), and mapping and system errors go to engineering (tier 4). The circuit breaker counts distinct records with the same error code in the current release of the batch.
- Lease breaks, pauses, resumes and scope decisions require an audit reason and the appropriate role.
- External notifications, automatic playbook PR creation and live configuration editing are not configured.
