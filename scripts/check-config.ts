import { loadPack } from '../packages/adapters/config';
import { evaluate } from '../packages/core/engine';
import { ingestRow } from '../packages/core/mapping';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const pack = loadPack(),
  fixture = JSON.parse(readFileSync('fixtures/bank1-extract.json', 'utf8'));
const report = fixture.rows.map((row: any) => {
  const result = evaluate(pack, ingestRow(pack, row));
  return {
    id: row.CUST_ID,
    state: result.state,
    score: result.score,
    failures: result.rules.filter((r) => !r.passed).map((r) => r.id),
  };
});
console.log(
  JSON.stringify(
    {
      schema: pack.schema.version,
      files: Object.keys(pack.version).length,
      records: report.length,
      warnings: pack.warnings,
      states: report.reduce(
        (out: any, r: any) => ((out[r.state] = (out[r.state] ?? 0) + 1), out),
        {},
      ),
    },
    null,
    2,
  ),
);
if (process.argv.includes('--report')) {
  mkdirSync('var', { recursive: true });
  writeFileSync('var/config-impact.json', JSON.stringify(report, null, 2));
}
const compareIndex = process.argv.indexOf('--compare');
if (compareIndex !== -1) {
  const previous = loadPack(process.argv[compareIndex + 1]);
  const changed = fixture.rows.flatMap((row: any) => {
    const before = evaluate(previous, ingestRow(previous, row)),
      after = evaluate(pack, ingestRow(pack, row));
    return JSON.stringify(before) !== JSON.stringify(after)
      ? [
          {
            recordId: row.CUST_ID,
            before: { state: before.state, score: before.score },
            after: { state: after.state, score: after.score },
          },
        ]
      : [];
  });
  console.log(JSON.stringify({ changedRecords: changed }, null, 2));
}
