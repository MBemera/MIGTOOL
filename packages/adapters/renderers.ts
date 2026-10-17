import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import JSZip from 'jszip';
import { type Data, type Envelope, type Pack, get, PlatformError } from '../core/model';
import { evaluate } from '../core/engine';
import { csv, csvRows } from '../core/mapping';
import { hash } from './config';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'node:fs';

export async function reportPdf(title: string, lines: string[], at: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setAuthor('MIGTOOL');
  doc.setCreator('MIGTOOL');
  doc.setProducer('MIGTOOL');
  doc.setCreationDate(new Date(at));
  doc.setModificationDate(new Date(at));
  let regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const available = new Set(regular.getCharacterSet());
  const text = lines.join('\n');
  if ([...text].some((c) => !available.has(c.codePointAt(0)!) && !['\n', '\r', '\t'].includes(c))) {
    const bytes = readFileSync('assets/fonts/DejaVuSans.ttf');
    const font = fontkit.create(bytes) as any;
    for (const c of text)
      if (!['\n', '\r', '\t'].includes(c) && !font.hasGlyphForCodePoint(c.codePointAt(0)))
        throw new PlatformError(
          'PDF_GLYPH_UNSUPPORTED',
          `Configured PDF font does not cover U+${c.codePointAt(0)!.toString(16).toUpperCase()}`,
        );
    doc.registerFontkit(fontkit);
    regular = await doc.embedFont(bytes, { subset: true });
  }
  let page = doc.addPage([595.28, 841.89]),
    y = 780;
  function header() {
    page.drawRectangle({ x: 0, y: 800, width: 596, height: 42, color: rgb(0, 0.44, 0.65) });
    page.drawText('MIGTOOL | BANK 1 TO BANK 2', {
      x: 38,
      y: 816,
      size: 10,
      font: bold,
      color: rgb(1, 1, 1),
    });
  }
  header();
  page.drawText(title, { x: 38, y, size: 16, font: bold });
  y -= 32;
  for (const line of lines) {
    const chunks: string[] = [];
    let current = '';
    for (const c of line.replace(/\t/g, '    ').replace(/\r/g, '')) {
      if (c === '\n') {
        chunks.push(current);
        current = '';
        continue;
      }
      if (regular.widthOfTextAtSize(current + c, 9) > 519) {
        chunks.push(current);
        current = c;
      } else current += c;
    }
    chunks.push(current);
    for (const chunk of chunks) {
      if (y < 50) {
        page = doc.addPage([595.28, 841.89]);
        y = 775;
        header();
      }
      page.drawText(chunk, { x: 38, y, size: 9, font: regular });
      y -= 15;
    }
    y -= 4;
  }
  return doc.save({ useObjectStreams: false });
}
export async function renderBundle(
  pack: Pack,
  record: Envelope,
): Promise<{ bytes: Buffer; digest: string; expected: Data; manifest: Data }> {
  const evaluation = evaluate(pack, record.data),
    zip = new JSZip(),
    expected: Data = {},
    files: Data[] = [];
  if (!evaluation.gates.cbs.open)
    throw new PlatformError(
      'GATE_CLOSED',
      'CBS gate must be open before creating a load bundle',
      409,
    );
  const at = new Date(record.createdAt),
    zipOptions = { date: at, createFolders: false };
  for (const mapping of pack.mappings) {
    if (!evaluation.gates[mapping.gate]?.open)
      throw new PlatformError('GATE_CLOSED', `${mapping.output} gate closed`, 409);
    let bytes: Uint8Array;
    if (mapping.kind === 'csv') {
      const rows = csvRows(pack, record, mapping);
      expected[mapping.output] = rows;
      bytes = Buffer.from(
        csv(
          mapping.columns.map((c) => c.name!),
          rows,
        ),
        'utf8',
      );
    } else
      bytes = await reportPdf(
        mapping.output === 'aaf.pdf' ? 'Application review summary' : 'Amendment review summary',
        [
          'SYNTHETIC MAPPING PACK. NOT AN OFFICIAL BANK APPLICATION FORM.',
          `Record: ${record.recordId} | Version: ${record.version} | Schema: ${record.schemaVersion}`,
          ...mapping.columns.map((c) => `${c.name}: ${String(get(record.data, c.from) ?? '')}`),
          `Accounts: ${record.data.accounts?.length ?? 0} | Signatories: ${record.data.signatories?.length ?? 0}`,
          'Official AAF XFA template and approved node bindings must be supplied before live use.',
        ],
        record.createdAt,
      );
    zip.file(mapping.output, bytes, zipOptions);
    files.push({ name: mapping.output, sha256: hash(bytes), size: bytes.length });
  }
  const manifest = {
    recordId: record.recordId,
    recordVersion: record.version,
    schemaVersion: record.schemaVersion,
    configVersion: pack.version,
    sourceRowHash: record.sourceRowHash,
    createdAt: record.createdAt,
    files,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2) + '\n', zipOptions);
  const bytes = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'DOS',
  });
  return { bytes, digest: hash(bytes), expected, manifest };
}
