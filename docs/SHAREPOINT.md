# SharePoint record storage

With SharePoint configured, each customer record is one JSON file in a SharePoint document library, and SharePoint is the authority for it (DEC-01, Graph route). Every app server keeps a local working copy in its own database. Staff on different machines, using one shared server or several, work on the same records safely.

The app talks to SharePoint only through Microsoft Graph. It never goes through the OneDrive sync client, so a check-out is visible to everyone immediately, and a record is only free again once SharePoint confirms the new version is saved.

## How a record is worked on

| Step                 | What happens                                                                                                                                                                                                                                          | Effect                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open                 | The app takes a lease in the SharePoint lease list (holder name, server, expiry), checks the file out, and downloads it with its version stamp (eTag). The local copy is replaced if SharePoint has a newer one.                                      | Nobody else can take the record. Other app users see "In use by _name_ since _time_". People in SharePoint see the last checked-in version and cannot edit it. |
| Edit                 | Work happens on the local copy. The draft is kept in the browser tab. The lease is renewed every 5 minutes while the person is active.                                                                                                                | Nothing partial goes to SharePoint.                                                                                                                            |
| Save                 | The app checks the lease is still held, saves locally, and uploads the record only if the file's version stamp is unchanged since check-out. It then writes the trace for the change to `trace/<record>/`, checks the file in, and deletes the lease. | The upload is all-or-nothing. SharePoint holds the old version until the new one is complete and checked in.                                                   |
| Close without saving | The check-out is undone and the lease deleted.                                                                                                                                                                                                        | SharePoint is unchanged.                                                                                                                                       |

The pipeline works the same way: import, export, CBS load, reconciliation and automatic fixes all check records out with a 5-minute worker lease. A bulk import first pulls current copies and skips any record checked out elsewhere (rejected as `LEASE_HELD`, re-import later). It then publishes each changed record, checking it out just before the upload.

Every 15 seconds each server:

- retries publishes that failed;
- publishes records that were waiting for someone else's check-out to end;
- pulls records other servers changed, skipping anything checked out or not yet published.

## Failure handling

- **A server crashes holding a record.** SharePoint check-outs never expire on their own, but the lease does after 15 minutes without renewal (5 for workers). Another server can then take the record over. The crashed server's late save is refused (`SHAREPOINT_LEASE_LOST`). Its local copy is kept in `remote_conflicts`, a tier 3 `SHAREPOINT_CONFLICT` exception is raised, and SharePoint is not overwritten.
- **An upload or check-in fails.** The file stays checked out with its previous content, and the lease stays held. The record stays closed on that server ("SharePoint publish in progress") and is retried until SharePoint confirms.
- **A person edits in SharePoint.** This is blocked while the record is checked out. Changes made while it was not checked out are pulled in before the next check-out.
- **An edit gets past the check-out**, for example through an administrator override. The version-stamp check rejects the app's upload (`SHAREPOINT_STALE`). SharePoint keeps that edit, and the app's change goes to review.
- **An administrator breaks a lease.** This undoes the check-out and deletes the lease on every server. The former holder's save is then refused, and their change goes to review.
- **SharePoint is slow or throttled** (HTTP 429/5xx). This is treated as transient: the pipeline's normal retries apply, and nothing is half-written.

Nothing is ever deleted from SharePoint by the app. Trace files are created once and never edited.

## Setup (IT)

1. **App registration** in Entra ID. Grant the Microsoft Graph application permission `Sites.Selected` with admin consent, then grant the app `write` on the migration site only. Create a client secret or certificate.
2. **Document library** for records, for example `Migration`. Create a folder for the app, for example `MIGTOOL`. The app creates `records/` and `trace/` inside it. Turning on versioning is recommended. "Require check out" may be on or off.
3. **Lease list**, for example `MIGTOOL Leases`. Set its columns:
   - `Title`: indexed, with **Enforce unique values** on. This is what stops two servers taking the same record.
   - `Holder`, `HolderName`, `Server`, `Token`, `Acquired`, `Expires`: single line of text.
4. **Restrict access**: only the app and administrators should be able to edit the lease list.
5. **Settings** on every app server:

| Variable                   | Value                                     |
| -------------------------- | ----------------------------------------- |
| `SHAREPOINT_TENANT_ID`     | Directory (tenant) ID                     |
| `SHAREPOINT_CLIENT_ID`     | Application (client) ID                   |
| `SHAREPOINT_CLIENT_SECRET` | Client secret                             |
| `SHAREPOINT_SITE_ID`       | Graph site ID of the migration site       |
| `SHAREPOINT_DRIVE_ID`      | Graph drive ID of the document library    |
| `SHAREPOINT_LEASE_LIST_ID` | Graph list ID of the lease list           |
| `SHAREPOINT_FOLDER`        | Folder in the library (default `MIGTOOL`) |
| `MIGTOOL_SERVER_ID`        | A distinct name for each app server       |

All six `SHAREPOINT_*` IDs must be set together. Partial configuration stops start-up. Each server's database stays on its own local disk, never in OneDrive. `/api/health` reports `"records": "sharepoint"` when it is active.

## Verification status

The SharePoint behaviour is tested against an in-memory simulation (`tests/fake-sharepoint.ts`) covering:

- check-out races between servers;
- people viewing and editing in SharePoint;
- failed uploads and retries;
- crash and takeover after expiry;
- edits that bypass the check-out;
- admin breaks;
- imports with records checked out elsewhere;
- the full pipeline;
- the HTTP routes on two servers.

The Graph client (`HttpGraphClient`) has **not yet been run against a real tenant**. In the test site, confirm:

1. Uploading to a checked-out file with `If-Match` returns 412 when the file changed.
2. Graph's `discardCheckout` is available. If not, the client falls back to checking in the unchanged file.
3. A duplicate `Title` in the lease list is refused, and how the error is reported (the client treats a 400 mentioning "unique" as a conflict).
4. The HTTP `Date` header is present, because lease expiry uses SharePoint's clock.
5. Check-out and check-in behave the same with "Require check out" on and off.

Until that is done, run with SharePoint in the test site only.
