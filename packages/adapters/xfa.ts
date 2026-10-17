import { PDFDocument, PDFArray, PDFDict, PDFName, PDFString, PDFHexString } from 'pdf-lib';
import { PlatformError } from '../core/model';
export function datasetsXml(bindings: Record<string, string>): string {
  const root: any = {};
  for (const [path, value] of Object.entries(bindings)) {
    const keys = path.split('.');
    if (
      keys.some(
        (k) =>
          !/^[A-Za-z_][\w-]*$/.test(k) || ['__proto__', 'constructor', 'prototype'].includes(k),
      )
    )
      throw new PlatformError('XFA_NODE', 'Invalid XFA node path');
    let node = root;
    for (const key of keys.slice(0, -1)) node = node[key] ??= {};
    node[keys.at(-1)!] = value;
  }
  const escape = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  const serialise = (node: any): string =>
    Object.entries(node)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(
        ([key, value]) =>
          `<${key}>${typeof value === 'string' ? escape(value) : serialise(value)}</${key}>`,
      )
      .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>${serialise(root)}</xfa:data></xfa:datasets>`;
}
export async function fillXfaTemplate(
  template: Uint8Array,
  bindings: Record<string, string>,
  at: string,
) {
  const pdf = await PDFDocument.load(template, { updateMetadata: false }),
    acro = pdf.catalog.lookup(PDFName.of('AcroForm'));
  if (!(acro instanceof PDFDict))
    throw new PlatformError('XFA_TEMPLATE', 'Template has no AcroForm dictionary');
  const xfa = acro.lookup(PDFName.of('XFA'));
  if (!(xfa instanceof PDFArray))
    throw new PlatformError(
      'XFA_TEMPLATE',
      'Only reviewed packet-array XFA templates are supported',
    );
  let filled = false;
  for (let i = 0; i < xfa.size() - 1; i += 2) {
    const name = xfa.lookup(i);
    if (
      (name instanceof PDFString || name instanceof PDFHexString) &&
      name.decodeText() === 'datasets'
    ) {
      xfa.set(i + 1, pdf.context.register(pdf.context.flateStream(datasetsXml(bindings))));
      filled = true;
    }
  }
  if (!filled) throw new PlatformError('XFA_TEMPLATE', 'Template has no datasets packet');
  pdf.setCreationDate(new Date(at));
  pdf.setModificationDate(new Date(at));
  return pdf.save({ useObjectStreams: false });
}
