// Bounded, in-memory probes for the 2026-10-25 security review.
// No PDF files, network requests, PDF JavaScript, or OS commands are executed.
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFString, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { buildPdf } from '../src/pdf.js';
import { loadLimitedPdf } from '../src/pdf-security.js';
import assert from 'node:assert/strict';

async function inspectExport() {
  const source = await PDFDocument.create();
  const first = source.addPage([595, 842]);
  const second = source.addPage([595, 842]);
  const marker = 'REMOVED_PAGE_SECRET_20261025';
  second.drawText(marker);
  const link = source.context.register(source.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 100, 40],
    Dest: [second.ref, PDFName.of('Fit')],
  }));
  first.node.set(PDFName.of('Annots'), source.context.obj([link]));
  // This is an inert marker: it is inspected as PDF data, never evaluated.
  first.node.set(PDFName.of('AA'), source.context.obj({
    O: { S: 'JavaScript', JS: PDFString.of('/* security review marker */') },
  }));
  const document = await PDFDocument.load(await source.save());
  const output = await buildPdf(
    [{ sourceId: 'source', index: 0, rotation: 0, strokes: [], watermark: null }],
    new Map([['source', { document }]]),
    () => { throw new Error('No overlay expected'); },
  );
  const result = await PDFDocument.load(output);
  const encodedMarker = Buffer.from(marker).toString('hex').toUpperCase();
  const retained = result.context.enumerateIndirectObjects().some(([, object]) =>
    object instanceof PDFRawStream && Buffer.from(decodePDFRawStream(object).decode())
      .toString('latin1').includes(encodedMarker));
  return {
    outputPageCount: result.getPageCount(),
    removedPageTextRetained: retained,
    pageOpenActionRetained: !!result.getPage(0).node.get(PDFName.of('AA')),
  };
}

function compressedInput() {
  // Fixed 64 MiB ceiling; deliberately do not accept an unbounded size argument.
  const expandedBytes = 64 * 1024 * 1024;
  const expanded = Buffer.alloc(expandedBytes, 32);
  expanded.write('999 0 null');
  const packed = deflateSync(expanded);
  const parts = [
    '%PDF-1.7\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n',
    `4 0 obj\n<< /Type /ObjStm /N 1 /First 6 /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`,
    packed,
    '\nendstream\nendobj\ntrailer\n<< /Root 1 0 R /Size 1000 >>\n%%EOF',
  ];
  return { bytes: Buffer.concat(parts.map(part => typeof part === 'string' ? Buffer.from(part) : part)), expandedBytes };
}

async function inspectExpansion() {
  const { bytes, expandedBytes } = compressedInput();
  // Collect the fixture-construction buffer before measuring parser allocations.
  globalThis.gc?.();
  const before = process.memoryUsage();
  const start = performance.now();
  let blocked = false, message;
  try { await loadLimitedPdf(bytes); } catch (error) {
    if (error.name !== 'PdfLimitError') throw error;
    blocked = true; message = error.message;
  }
  const after = process.memoryUsage();
  return {
    inputBytes: bytes.length, expandedBytes, blocked, message,
    elapsedMs: Math.round(performance.now() - start),
    arrayBufferGrowthBytes: after.arrayBuffers - before.arrayBuffers,
    rssGrowthBytes: after.rss - before.rss,
  };
}

const result = { export: await inspectExport(), expansion: await inspectExpansion() };
assert.equal(result.export.removedPageTextRetained, false);
assert.equal(result.export.pageOpenActionRetained, false);
assert.equal(result.expansion.blocked, true);
console.log(JSON.stringify(result, null, 2));
