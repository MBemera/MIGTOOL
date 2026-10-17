import { type Data, type Pack, PlatformError } from '../core/model';
import { hash } from './config';

// RFC 4180 parser: quoted fields, doubled quotes, CRLF or LF, optional UTF-8 BOM.
export function parseCsv(
  text: string,
  file = 'file',
  keepBlank = false,
): { header: string[]; rows: Data[] } {
  if (text.includes('�')) throw new PlatformError('EXTRACT_ENCODING', `${file} is not valid UTF-8`);
  const source = text.replace(/^﻿/, ''),
    records: string[][] = [];
  let field = '',
    record: string[] = [],
    quoted = false,
    i = 0;
  while (i < source.length) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') quoted = false;
      else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      record.push(field);
      records.push(record);
      field = '';
      record = [];
      if (c === '\r' && source[i + 1] === '\n') i++;
    } else field += c;
    i++;
  }
  if (quoted) throw new PlatformError('EXTRACT_INVALID', `${file}: unterminated quoted field`);
  if (field !== '' || record.length) {
    record.push(field);
    records.push(record);
  }
  const [header, ...body] = records.filter((r) => !(r.length === 1 && r[0] === ''));
  if (!header) throw new PlatformError('EXTRACT_INVALID', `${file} is empty`);
  if (new Set(header).size !== header.length)
    throw new PlatformError('EXTRACT_INVALID', `${file}: duplicate column names`);
  const rows = body.map((cells, index) => {
    if (cells.length !== header.length)
      throw new PlatformError(
        'EXTRACT_INVALID',
        `${file} line ${index + 2}: expected ${header.length} columns, found ${cells.length}`,
      );
    // Blank extract cells are absent values, so nothing is ingested for them.
    return Object.fromEntries(
      header.flatMap((name, c) => (!keepBlank && cells[c].trim() === '' ? [] : [[name, cells[c]]])),
    );
  });
  return { header, rows };
}

export type CsvPackage = Record<string, string>;
// Converts a Bank 1 CSV extract package (one customer file, one file per repeating group and a
// control file of row counts and SHA-256 checksums) into the nested rows the ingest mapping reads.
// Any file-level fault stops the whole batch (WF-01 step 1).
export function csvPackageToExtract(pack: Pack, files: CsvPackage, name = 'Bank 1 CSV extract') {
  const layout = pack.ingest.csv;
  if (!layout) throw new PlatformError('EXTRACT_INVALID', 'No CSV layout is configured', 500);
  const key = pack.ingest.key,
    dataFiles = [layout.customers, ...Object.values(layout.groups)];
  for (const file of [layout.control, ...dataFiles])
    if (typeof files[file] !== 'string')
      throw new PlatformError('EXTRACT_INVALID', `Missing extract file ${file}`);
  const unexpected = Object.keys(files).filter((f) => ![layout.control, ...dataFiles].includes(f));
  if (unexpected.length)
    throw new PlatformError(
      'EXTRACT_INVALID',
      `Unexpected extract files: ${unexpected.join(', ')}`,
    );

  const control = parseCsv(files[layout.control], layout.control);
  for (const column of ['FILE', 'ROWS', 'SHA256'])
    if (!control.header.includes(column))
      throw new PlatformError('EXTRACT_INVALID', `${layout.control}: missing column ${column}`);
  const declared = new Map(control.rows.map((r) => [r.FILE, r]));
  const parsed: Record<string, Data[]> = {};
  for (const file of dataFiles) {
    const entry = declared.get(file);
    if (!entry)
      throw new PlatformError('EXTRACT_INVALID', `${layout.control} does not list ${file}`);
    if (String(entry.SHA256).toLowerCase() !== hash(files[file]))
      throw new PlatformError(
        'CHECKSUM_MISMATCH',
        `${file} checksum does not match ${layout.control}`,
      );
    const { header, rows } = parseCsv(files[file], file);
    const bindings =
      file === layout.customers
        ? pack.ingest.fields
        : pack.ingest.groups.find((g) => layout.groups[g.from] === file)!.fields;
    for (const column of [key, ...bindings.map((b) => b.from)])
      if (!header.includes(column))
        throw new PlatformError('EXTRACT_INVALID', `${file}: missing column ${column}`);
    // Customer and account counts are control totals checked by ingest; other files must match here.
    if (
      ![layout.customers, layout.groups.ACCOUNTS].includes(file) &&
      Number(entry.ROWS) !== rows.length
    )
      throw new PlatformError(
        'EXTRACT_INVALID',
        `${file}: ${layout.control} declares ${entry.ROWS} rows, file has ${rows.length}`,
      );
    parsed[file] = rows;
  }

  const customers = parsed[layout.customers].map((row) => {
    const out: Data = { ...row };
    for (const group of Object.keys(layout.groups)) out[group] = [];
    return out;
  });
  const byKey = new Map(customers.map((c) => [String(c[key] ?? ''), c]));
  for (const [group, file] of Object.entries(layout.groups))
    parsed[file].forEach((row, index) => {
      const owner = byKey.get(String(row[key] ?? ''));
      if (!owner)
        throw new PlatformError(
          'EXTRACT_INVALID',
          `${file} line ${index + 2}: ${key} ${row[key] ?? '(blank)'} is not in ${layout.customers}`,
        );
      const { [key]: _, ...item } = row;
      owner[group].push(item);
    });

  const accountsFile = layout.groups.ACCOUNTS;
  return {
    name,
    rows: customers,
    // Control totals come from the control file, so a short or padded data file is caught by the
    // ingest comparison rather than trusted.
    totals: {
      customerCount: Number(declared.get(layout.customers)!.ROWS),
      accountCount: accountsFile ? Number(declared.get(accountsFile)!.ROWS) : 0,
    },
    sourceFiles: Object.fromEntries(dataFiles.map((f) => [f, hash(files[f])])),
  };
}
