# Bank 1 CSV extract to Bank 2 CBS load

This is the end-to-end path for a Bank 1 CSV extract: verify the files, convert them into records, validate, resolve gaps, export the Bank 2 CBS load files, read them back and reconcile. All data in `fixtures/bank1-csv` is invented for testing. Names, ABNs, account numbers and addresses do not belong to real customers.

## Example extract: 10 customers

Ages are as at 17 October 2026, calculated from `DATE_OF_BIRTH`.

| Bank 1 ID | Customer                        | Type        | Address                | Accounts          | People (age, role)                                           |
| --------- | ------------------------------- | ----------- | ---------------------- | ----------------- | ------------------------------------------------------------ |
| B1-100001 | Harbourview Logistics Pty Ltd   | company     | Pyrmont NSW 2009       | TRAN, SAVE, FX    | Daniel Harbour (55, director); Priya Harbour (51, director)  |
| B1-100002 | Kowalski Family Trust           | trust       | Hawthorn VIC 3122      | TD                | Anna Kowalski (68, owner); Tomasz Kowalski (39, beneficiary) |
| B1-100003 | Mia Chen                        | sole trader | Brisbane City QLD 4000 | TRAN, CARD        | Mia Chen (32, owner)                                         |
| B1-100004 | O'Brien, Kelly & Co Pty Ltd     | company     | Adelaide SA 5000       | TRAN, OD, PAYROLL | Siobhan O'Brien (57, director); Marcus Kelly (46, director)  |
| B1-100005 | Top End Fisheries Pty Ltd       | company     | Darwin NT 800          | TRAN, LOAN        | Wayne Tipungwuti (48, director)                              |
| B1-100006 | Zoë Müller                      | sole trader | Hobart TAS 7000        | SAVE              | Zoë Müller (36, owner)                                       |
| B1-100007 | Patel & Singh Partners          | partnership | Perth WA 6000          | TRAN, TRUST       | Ravi Patel (61, owner); Harpreet Singh (54, owner)           |
| B1-100008 | Capital Region Builders Pty Ltd | company     | Braddon ACT 2612       | TRAN, GUARANTEE   | Liam Walsh (43, director)                                    |
| B1-100009 | Nguyen Bakery Pty Ltd           | company     | Richmond VIC 3121      | TRAN, MERCHANT    | Thu Nguyen (47, director); Bao Nguyen (22, contact)          |
| B1-100010 | Ruth Okafor                     | sole trader | Coolangatta QLD 4225   | SAVE              | Ruth Okafor (27, owner)                                      |

Totals: 10 customers, 19 accounts, 15 people, 13 signatories (directors and owners).

The set deliberately includes cases the pipeline must handle:

- **Darwin postcode `800`.** Bank 1 dropped the leading zero. The approved playbook entry `pb-demo-postcode` pads it to `0800` automatically (tier 1), with provenance `playbook`.
- **Quoted values.** `O'Brien, Kelly & Co Pty Ltd` and `Level 3, 100 King William Street` contain commas and apostrophes.
- **Non-ASCII names.** `Zoë Müller` round-trips through CSV, records, PDFs and load files unchanged.
- **Foreign tax resident.** Zoë Müller is a UK tax resident (`FOREIGN_TAX=Y`), so her foreign TIN becomes a customer-declared gap.
- **Missing email.** Capital Region Builders has no email. It is left blank and raised as a warning, never guessed.
- **Formatted source values.** ABNs arrive as `51 000 000 680` and BSBs as `062-000`. Both are normalised to digits. Dates arrive as `DD/MM/YYYY` and are stored as ISO dates.

## Extract package format

The layout is configured in `config/mappings/ingest/bank1.yaml` (`csv` section). All files are UTF-8 RFC 4180 CSV with a header row. Blank cells are treated as absent values.

| File              | One row per    | Columns                                                                                                                     |
| ----------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `customers.csv`   | customer       | CUST_ID, CUST_LEGAL_NAME, CUST_TYPE, CUST_ABN, EMAIL, ADDRESS, SUBURB, STATE, POSTCODE, COUNTRY, TAX_RESIDENCY, FOREIGN_TAX |
| `accounts.csv`    | account        | CUST_ID, PRODUCT, NUMBER, BSB, OPEN_DATE                                                                                    |
| `people.csv`      | related person | CUST_ID, NAME, DATE_OF_BIRTH, EMAIL, ROLE                                                                                   |
| `signatories.csv` | signatory      | CUST_ID, NAME                                                                                                               |
| `control.csv`     | data file      | FILE, ROWS, SHA256                                                                                                          |

`npm run csv:control -- <folder>` regenerates `control.csv` after a fixture is edited. A real Bank 1 extract must arrive with its own control file. Never regenerate one for a received extract.

## What the import checks

Each of these faults stops the whole batch, writes a `file_rejected` trace event and raises a tier 4 exception (WF-01 step 1):

- a missing, unexpected or empty file
- a file that is not valid UTF-8
- an unterminated quote
- the wrong number of columns on a line
- a missing mapped column
- a checksum that differs from `control.csv`
- a child row whose `CUST_ID` is not in `customers.csv`
- a people or signatory row count that differs from `control.csv`

Customer and account counts from `control.csv` are the batch control totals. A mismatch puts the batch on hold before any record is written (TC-042).

Row-level faults, such as a duplicate customer key or an unknown product code, reject only that row to the exception queue.

## Running it

### Browser

1. Sign in as admin and open **Import extract**.
2. Select **Use example CSV extract**, or choose all five files together. Then select **Import CSV and validate**.
3. Operators open each customer from the queue and enter the customer-declared evidence:
   - the tax declaration
   - signatory identity references
   - the foreign TIN for Zoë Müller
   - the missing email for Capital Region Builders
4. In **Batch control**, select **Release ready**. The worker exports each record, writes its CBS load folder, reads it back and reconciles.
5. Select **CBS load files** to download the combined `Customer_Create.csv`, `Account_Register.csv` and `User_Create.csv` with a manifest of row counts and SHA-256 hashes.

### Command line

```sh
npm run import:csv -- fixtures/bank1-csv
npm run export:batch -- <batchId> var/cbs-batches
```

## Bank 2 CBS output

Each delivered record gets its own folder in the CBS load folder (`CBS_OUTBOX`, default `cbs-outbox` beside the database). The folder is named from the record and its output hash, and holds the three CSV files and a `manifest.json`.

| File                   | Rows             | Columns                                                                |
| ---------------------- | ---------------- | ---------------------------------------------------------------------- |
| `Customer_Create.csv`  | one per customer | CUSTOMER_ID, LEGAL_NAME, ABN, POSTCODE                                 |
| `Account_Register.csv` | one per account  | CUSTOMER_ID, PRODUCT_CODE, ACCOUNT_NUMBER, BSB, OPEN_DATE (DD/MM/YYYY) |
| `User_Create.csv`      | one per person   | CUSTOMER_ID, NAME, DATE_OF_BIRTH (DD/MM/YYYY), EMAIL, ROLE             |

Reconciliation parses the written CSV files back and compares them cell by cell with the export. A difference names the file, row, column and mapped record field (for example `accounts[0].bsb`) as a `mapping` error. When every record in a batch is reconciled, the customer and account counts read back from the load folder are compared with the export totals before the batch is marked completed.

The load folder applies two acceptance checks of its own, so CBS rejections and triage can be exercised:

| Code        | Rule                                         | Error class | First tier                    |
| ----------- | -------------------------------------------- | ----------- | ----------------------------- |
| `CBS-E1042` | Postcode must be four digits                 | data        | 1 (`pb-0007` pads it), then 3 |
| `CBS-E2001` | Product code must exist in Bank 2's products | mapping     | 4 (fix the mapping)           |

The column sets, codes and checks are placeholders. Replace them with the real CBS load specification (DEC-07) before live use.
