# MIGTOOL

A tool for moving customer records from one system to another. It loads customer data from CSV files, checks it, lets staff fill the gaps, and produces load files for the target system.

## What it does

- Reads customer data from CSV files.
- Turns each customer into one record.
- Checks every record against a set of rules.
- Fills obvious formatting gaps automatically, such as a missing leading zero.
- Leaves anything a customer must declare for a person to enter. It never guesses.
- Shows staff a queue of records that need attention.
- Lets one person edit a record at a time.
- Writes load files for the target system when a record is ready.
- Reads the load files back to prove they match.
- Records every step in an audit trail that cannot be changed.

## Parts of the application

| Part                  | What it is                                                                       |
| --------------------- | -------------------------------------------------------------------------------- |
| Web app               | The screens staff use in a browser.                                              |
| Server                | Runs the web app and the API, and does the background work.                      |
| Worker                | Optional extra process for background work.                                      |
| Rules and settings    | YAML files in `config/`. They define fields, rules, checks and file layouts.     |
| Local database        | One SQLite file per server. Holds the working copy, audit trail, users and jobs. |
| Landing folder        | Where source CSV files arrive. Can be a OneDrive folder.                         |
| Load folder           | Where load files for the target system are written. Can be a OneDrive folder.    |
| SharePoint (optional) | The shared home for records when staff work from several machines.               |

## User roles

| Role     | Can do                                                                                       |
| -------- | -------------------------------------------------------------------------------------------- |
| Operator | View and edit records, work the queue.                                                       |
| Reviewer | Everything an operator can, plus approve changes, decide scope and approve fixes.            |
| Admin    | Everything, plus import files, release batches, break locks, pause batches and manage users. |

Sessions last 4 hours.

## How a record moves through the system

1. **Imported.** Created from the CSV files.
2. **Checked.** Rules run. The record gets a score.
3. **Needs input.** Something only a person can supply is missing.
4. **Blocked.** A rule failed for another reason.
5. **Ready.** All checks pass.
6. **Exported.** Load files are written.
7. **Loaded.** The target system accepted the files.
8. **Reconciled.** The files read back match the record.

Other states:

- **Amendment pending.** The source changed after the record was loaded. A reviewer must approve the change.
- **On hold.** Paused by an admin or by the safety checks.
- **Withdrawn.** Removed from scope by a reviewer.

## Workflows

### 1. Import

1. Source CSV files arrive in the landing folder, in their own subfolder.
2. An admin selects **Import extract** and picks the files or the subfolder.
3. The files are checked first:
   - All expected files are present.
   - Each file matches the checksum in `control.csv`.
   - Columns and row counts are correct.
4. If any file check fails, nothing is imported.
5. Each customer becomes a record.
6. Importing the same file again changes nothing.
7. Bad rows go to the queue. Good rows carry on.

### 2. Check

1. Rules run after every change.
2. Simple formatting problems are fixed automatically if an approved fix exists.
3. Missing customer declarations go to the queue for a person.
4. When all rules pass, the record is ready.

### 3. Edit

1. A person opens a record from the queue.
2. The record is locked to them.
3. They fill the gaps and save.
4. Rules run again.
5. The lock is released.

### 4. Release and load

1. An admin selects **Release ready** on a batch.
2. For each ready record the worker:
   - writes the load files;
   - delivers them to the load folder;
   - reads them back and compares them with the record.
3. If they match, the record is reconciled.
4. **Load files** gives the combined files for the whole batch.

After an amendment is approved and reconciled, **Download bundle** and **Load files** contain the amended values. Earlier bundles are retained for audit.

### 5. Problems

| Problem                          | What happens                                               |
| -------------------------------- | ---------------------------------------------------------- |
| Temporary fault                  | Retried automatically: after 1, 4, 16, 64 and 256 seconds. |
| Known fault with an approved fix | Fixed automatically, once.                                 |
| Data problem                     | Sent to the queue for a person.                            |
| Mapping or system problem        | Sent to the queue for the technical team.                  |
| Same fault on many records       | The batch is paused.                                       |

### 6. Source changes later

- Fields nobody edited take the new value.
- Fields a person edited are never overwritten. A clash goes to review.
- A record that has already been loaded is frozen. Changes go through an amendment for a reviewer to approve.
- A customer missing from a new full file is flagged. It is never deleted.

## Locks: one person per record

- Opening a record takes a lock.
- The lock lasts 15 minutes.
- The lock is renewed every 5 minutes while the person is active.
- Anyone else opening the record sees **"In use by _name_ since _time_"** and gets a read-only view.
- Saving, closing or leaving the page releases the lock.
- After 25 minutes idle, the person is warned.
- After 30 minutes idle, the lock is released. Their unsaved draft stays in the browser tab.
- If the lock expires, the person can take it again if it is still free.
- Every save carries a version number. A save made from an out-of-date copy is rejected. The person is shown what changed.
- Only an admin can break a lock, and must give a reason. The holder is told.
- Background jobs take locks too, so a person and a job never edit the same record at once.

## Working from several machines (SharePoint)

Records live in SharePoint. Each app server keeps a local working copy.

Batch membership and delivery outputs are shared too. An admin can release a batch from another server. Batch controls use their own check-out so a pause or resume is respected before the next job. All workers need access to the same load folder for readback.

### How it works

| Step                 | What happens                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Open                 | The app takes a lock in a SharePoint list, checks the file out in SharePoint, and downloads it.                                              |
| While open           | Nobody else can open it, on any machine. People in SharePoint can view the last saved version but cannot edit it.                            |
| Save                 | The app uploads the record only if the file has not changed since it was checked out. It then checks the file back in and releases the lock. |
| Close without saving | The check-out is undone. SharePoint is unchanged.                                                                                            |
| Background           | Every 15 seconds each server picks up changes made on other machines, and retries any save that did not finish.                              |

### When something goes wrong

- **A server crashes holding a record.** The lock expires after 15 minutes and another server can take over. The crashed server's late save is refused and kept for review. SharePoint is not overwritten.
- **An upload fails.** The file stays checked out with its old content. The save is retried until SharePoint confirms it.
- **Someone edits directly in SharePoint.** Blocked while the file is checked out. If an edit gets through anyway, the app's save is refused and sent to review. Nothing is overwritten.
- **An admin breaks a lock.** The check-out is undone everywhere. The old holder's save is refused and sent to review.

## How temp files and sync clashes are stopped

- **The database is never synced.** Each server's database stays on local disk. The app refuses to start if the database is in OneDrive, SharePoint sync, Dropbox, Google Drive or iCloud.
- **The landing folder is read only.** The app never writes, renames or deletes there.
- **Landing files are checked before import.** The import stops with a clear reason when:
  - a file is open in Excel (`~$` lock file present);
  - a conflict copy is present, such as `customers (1).csv`;
  - a file changed in the last 30 seconds, because it may still be syncing;
  - a file is online-only and cannot be read;
  - a file is cut short, which the checksum in `control.csv` catches.
- **Load files appear complete or not at all.** They are written in a local staging folder outside OneDrive, then moved into the load folder in one step. OneDrive never sees a half-written file.
- **The staging folder must be on the same drive as the load folder**, so the move is one step and not a copy. The app checks this at start-up.
- **Nothing is ever overwritten.**
  - Each delivery has its own folder, named with a hash of its contents.
  - Sending the same content again does nothing.
  - Different content under the same name is an error.
  - So there is nothing for OneDrive to turn into a conflict copy.
- **Leftover staging from a crash** is removed at the next start.
- **Records are never edited through a sync client.** With SharePoint, the app uses check-out and check-in instead.
- **Browser drafts stay in the browser tab.** They are never written to disk.
- **The health check reports any temp files or conflict copies it finds.** Look at `strayFiles` at `/api/health`. It should be 0.

## Setup

### Needs

- Node.js 24 and npm.
- Windows, macOS or Linux.

### Try it with example data

```sh
npm ci
npm run demo
```

Open http://127.0.0.1:5173.

| Role     | Username | Password           |
| -------- | -------- | ------------------ |
| Admin    | admin    | demo-admin-2026    |
| Operator | operator | demo-operator-2026 |
| Reviewer | reviewer | demo-reviewer-2026 |

1. Go to **Import extract**, select **Use example CSV extract**, then **Import CSV and validate**.
2. Open a customer from **Customer records**.
3. Fill in the declaration and identity fields, then save.
4. Go to **Batch control** and select **Release ready**.
5. Select **Load files** to download the load files.

Demo accounts exist only in demo mode. Do not use them on a shared server.

### Normal install

1. Run `npm ci`.
2. Copy `.env.example` to `.env`.
3. Set the admin password and the folders (see below).
4. Run `npm run build`.
5. Run `npm start`.
6. Open http://127.0.0.1:3001.

### Settings

| Setting                                        | What it is                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `HOST`, `PORT`                                 | Where the server listens. Default `127.0.0.1:3001`. Set `HOST=0.0.0.0` to let other machines connect.                    |
| `APP_ORIGIN`                                   | The exact address staff use in the browser.                                                                              |
| `NODE_ENV=production`                          | Use behind HTTPS on a shared server.                                                                                     |
| `MIGTOOL_ADMIN_USER`, `MIGTOOL_ADMIN_PASSWORD` | First admin account. The password must be at least 12 characters.                                                        |
| `DATABASE_PATH`                                | The local database. Must be on local disk.                                                                               |
| `EXTRACT_LANDING`                              | The landing folder. Can be in OneDrive.                                                                                  |
| `LOAD_FOLDER`                                  | The load folder. Can be in OneDrive.                                                                                     |
| `LOAD_STAGING`                                 | Local staging folder. Must be on the same drive as the load folder and not in OneDrive. Defaults to beside the database. |

### OneDrive folders

1. Point `EXTRACT_LANDING` and `LOAD_FOLDER` at the OneDrive folders.
2. Keep `DATABASE_PATH` on local disk.
3. If the database is on a different drive from OneDrive, set `LOAD_STAGING` to a local folder on the OneDrive drive.
4. Set the landing folder to **Always keep on this device**.

### SharePoint (several machines)

**IT sets up:**

1. An app registration in Entra ID with `Sites.Selected`, given write access to the one site.
2. A document library folder for records (default `MIGTOOL`).
3. A lock list:
   - a `Title` column set to **Enforce unique values** and indexed;
   - text columns `Holder`, `HolderName`, `Server`, `Token`, `Acquired`, `Expires`.
4. Edit access to the lock list for the app and admins only.

**On every app server, set:**

| Setting                    | Value                            |
| -------------------------- | -------------------------------- |
| `SHAREPOINT_TENANT_ID`     | Tenant ID                        |
| `SHAREPOINT_CLIENT_ID`     | App ID                           |
| `SHAREPOINT_CLIENT_SECRET` | App secret                       |
| `SHAREPOINT_SITE_ID`       | Site ID                          |
| `SHAREPOINT_DRIVE_ID`      | Library ID                       |
| `SHAREPOINT_LEASE_LIST_ID` | Lock list ID                     |
| `SHAREPOINT_FOLDER`        | Folder name (default `MIGTOOL`)  |
| `MIGTOOL_SERVER_ID`        | A different name for each server |

Notes:

- Set all six IDs, or none. A partial setup stops the server starting.
- `/api/health` shows `"records": "sharepoint"` when SharePoint is on.
- The SharePoint connection has been tested against a simulation only. Test it in a test site before live use.

### Shared server instead of SharePoint

- Run one server that everyone reaches in a browser.
- Set `HOST=0.0.0.0` and `APP_ORIGIN`, and put HTTPS in front of it.
- Locks then work the same way, with no SharePoint needed.

## Commands

| Command                                      | Does                                            |
| -------------------------------------------- | ----------------------------------------------- |
| `npm run demo`                               | Start with example data.                        |
| `npm start`                                  | Start the server.                               |
| `npm run worker`                             | Start an extra background worker.               |
| `npm run import:csv -- <folder>`             | Import a CSV folder from the command line.      |
| `npm run export:batch -- <batchId> [folder]` | Write a batch's combined load files.            |
| `npm run csv:control -- <folder>`            | Rebuild `control.csv` for test data you edited. |
| `npm run check:config`                       | Check the rules and settings files.             |
| `npm run revalidate`                         | Re-check open records after a rules change.     |
| `npm test`                                   | Run the tests.                                  |
| `npm run test:e2e`                           | Run the browser tests.                          |
| `npm run build`                              | Build the app.                                  |

## CSV files

Each import is one folder with these files:

| File              | One row per                                     |
| ----------------- | ----------------------------------------------- |
| `customers.csv`   | Customer                                        |
| `accounts.csv`    | Account                                         |
| `people.csv`      | Related person                                  |
| `signatories.csv` | Signatory                                       |
| `control.csv`     | Data file: name, row count and SHA-256 checksum |

Rules for the files:

- All files are UTF-8 CSV with a header row.
- Child rows link to customers by `CUST_ID`.
- Blank cells are treated as missing values.
- Example data is in `fixtures/sample-csv`. It is invented, not real people.

## Load files produced

| File                   | One row per              |
| ---------------------- | ------------------------ |
| `Customer_Create.csv`  | Customer                 |
| `Account_Register.csv` | Account                  |
| `User_Create.csv`      | Related person           |
| `manifest.json`        | Row counts and checksums |

## Limits

- The target system connection is a load folder. There is no live link.
- Column layouts and rule codes are examples until the real file specifications are supplied.
- AI-suggested fixes are turned off.
