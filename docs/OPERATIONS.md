# Operations

## Process and storage

The server serves the built React interface and authenticated API on port 3001. It also runs one delivery-queue loop. `npm run worker` can run an additional worker against the same local SQLite database; leases and conditional writes prevent interleaved edits. All processes must use the same configuration release.

Use local persistent disk for SQLite. The database and the staging area are refused inside a sync client folder (`OneDrive`, `OneDrive - <org>`, `SharePoint`, `Dropbox`, `Google Drive`, `iCloud Drive`, or the paths in the `OneDrive*` environment variables), because SQLite's WAL and shared-memory files cannot survive a sync client. The extract landing folder and the CBS load folder may be in OneDrive or SharePoint: see below.

Imports are committed as a batch transaction. Input is durably queued first, so an abrupt process failure leaves a replayable import. The local synchronous engine can occupy the request process during large imports. Production load and the two-second lease-visibility target need verification on the actual deployment, or imports should run in a separate service with an appropriate database.

The queue stores each record's stage in the record plus output hashes and idempotent acceptance receipts. A process that dies while holding a lease waits for server-time expiry before another holder can proceed. Delivery jobs become reclaimable after five minutes.

## Environment

| Variable                     | Purpose                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `HOST`                       | Defaults to `127.0.0.1`. Explicit demo refuses a public bind.                                       |
| `PORT`                       | Defaults to `3001`.                                                                                 |
| `DATABASE_PATH`              | Normal workspace database, defaults to `var/migtool.sqlite`.                                        |
| `MIGTOOL_ADMIN_USER`         | Initial admin username, defaults to `admin`.                                                        |
| `MIGTOOL_ADMIN_PASSWORD`     | Required on the first normal start; minimum 12 characters.                                          |
| `APP_ORIGIN`                 | Exact browser origin allowed for mutations. Set the HTTPS origin for a shared deployment.           |
| `NODE_ENV`                   | Set to `production` for secure cookies behind HTTPS.                                                |
| `MIGTOOL_DEMO_DATABASE_PATH` | Optional isolated demo/test database location.                                                      |
| `CBS_OUTBOX`                 | Bank 2 CBS load folder; may be in OneDrive. Defaults to `cbs-outbox` beside the database.           |
| `CBS_STAGING`                | Local staging folder, on the same drive as `CBS_OUTBOX`. Defaults to `staging` beside the database. |
| `EXTRACT_LANDING`            | Bank 1 extract landing folder; may be in OneDrive. One subfolder per extract package.               |

Initial administrator variables only bootstrap an empty user database. Changing them does not rotate an existing account password. Do not run demo mode against real data. `.env` and all databases are ignored by git.

The default operating thresholds live in `config/operations.yaml`, are validated at startup and are included in configuration fingerprints. Human renewal runs every five minutes while active. The UI warns at 25 minutes and releases after 30 minutes of inactivity. Drafts remain in session storage for that user and tab. A stale draft retains its original ETag, so it cannot silently overwrite a newer version.

## OneDrive folders, temp files and sync conflicts

Operation relies on two OneDrive (or SharePoint-synced) folders: the Bank 1 extract landing folder and the Bank 2 CBS load folder. Both are supported. Records, leases and the audit trail stay in the database on local disk, which is the one authority per record (P6). Sync faults in the original tool (section 10.1) came from several people writing the same files through the sync client. That cannot happen here, because the app never edits a file in a synced folder.

**Landing folder (`EXTRACT_LANDING`): read only.**

- Each extract is a subfolder holding the five CSV files. **Import extract → Landing folder** lists them; `npm run import:csv -- <subfolder>` also works.
- The app never creates, renames, moves or deletes anything in the landing folder, so it causes no sync activity there.
- An import stops with a plain reason if:
  - an Excel lock file (`~$customers.csv`) is present — the file is still open;
  - a conflict copy (`customers (1).csv`, `customers-DESKTOP-ABC.csv`) or temp file is present — resolve it in OneDrive first;
  - a file changed in the last 30 seconds — OneDrive may still be syncing;
  - an online-only file cannot be read — set the landing folder to **Always keep on this device**.
- A partly synced file that passes those checks still fails the `control.csv` checksum, and nothing is imported.

**CBS load folder (`CBS_OUTBOX`): complete folders only, never changed.**

- Every delivery is written and flushed in `CBS_STAGING`, outside the synced tree, then moved into the load folder in one rename. OneDrive therefore only ever sees a finished folder appear. It never sees a temp file, a partial file or a staging folder.
- `CBS_STAGING` must be on the same drive as the load folder, so the move is a single step and not a copy. Start-up checks this and refuses a staging folder on another drive or inside a synced folder.
- Nothing in the load folder is overwritten. A repeat delivery of identical content is a no-op, and different content under an existing name is an error. Folder names include the output hash. So there is nothing for OneDrive to turn into a conflict copy.
- Staging left by a crash is removed at start-up once it is an hour old. Delivery is idempotent, so the job is simply retried.

**Monitoring.** `/api/health` reports `strayFiles` across the load and landing folders: temp files, staging leftovers and conflict-copy names. Anything above 0 needs investigation.

**What is still not supported.** Placing the database in OneDrive, or having several machines run the app against one synced copy of it. Sharing records across sites needs the Graph or backend storage route (DEC-01). Browser drafts stay in the tab's session storage and are never written to disk.

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
