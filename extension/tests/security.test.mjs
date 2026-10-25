import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFString, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { unzipSync } from 'fflate';
import { buildPdf } from '../src/pdf-export.js';
import { loadLimitedPdf, createPdfBudget } from '../src/pdf-security.js';
import { processPdfJob } from '../src/pdf-jobs.js';
import { runPdfJob } from '../src/pdf-processor.js';
import { PDF_LIMITS } from '../src/limits.js';

const record = index => ({ sourceId: 'source', index, rotation: 90, strokes: [], watermark: null });
const marker = 'REMOVED_PAGE_SECRET_20261025';

async function linkedSource() {
  const document = await PDFDocument.create();
  const first = document.addPage([240, 360]), second = document.addPage([300, 400]);
  first.drawText('KEEP_THIS'); second.drawText(marker);
  const annotation = document.context.register(document.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 100, 40], Dest: [second.ref, PDFName.of('Fit')],
  }));
  first.node.set(PDFName.of('Annots'), document.context.obj([annotation]));
  first.node.set(PDFName.of('AA'), document.context.obj({ O: { S: 'JavaScript', JS: PDFString.of('/* inert audit marker */') } }));
  // An unexpected page reference inside Resources must also be excluded.
  first.node.Resources().set(PDFName.of('UnexpectedPage'), second.ref);
  return document;
}

async function assertClean(bytes) {
  const output = await PDFDocument.load(bytes);
  assert.equal(output.getPageCount(), 1);
  const page = output.getPage(0);
  assert.equal(page.getRotation().angle, 90);
  assert.equal(page.node.get(PDFName.of('Annots')), undefined);
  assert.equal(page.node.get(PDFName.of('AA')), undefined);
  const hex = Buffer.from(marker).toString('hex').toUpperCase();
  for (const [, object] of output.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) assert.ok(!Buffer.from(decodePDFRawStream(object).decode()).toString('latin1').includes(hex));
  }
  const loading = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replaceAll('\\', '/') });
  try {
    const document = await loading.promise;
    const content = await (await document.getPage(1)).getTextContent();
    assert.ok(content.items.some(item => item.str.includes('KEEP_THIS')));
  } finally { await loading.destroy(); }
}

test('export excludes linked deleted pages and actions without modifying the source', async () => {
  const document = await linkedSource();
  const before = document.getPage(0).node.toString();
  await assertClean(await buildPdf([record(0)], new Map([['source', { document }]])));
  assert.equal(document.getPage(0).node.toString(), before);
  assert.equal(document.getPageCount(), 2);
});

test('actual export and ZIP job pipelines exclude other pages while keeping text and rotation', async () => {
  const bytes = await (await linkedSource()).save();
  const job = { sources: [{ id: 'source', bytes }], records: [record(0)], title: '../example' };
  await assertClean(await processPdfJob({ ...job, type: 'export' }));
  const files = unzipSync(await processPdfJob({ ...job, type: 'split' }));
  assert.deepEqual(Object.keys(files), ['.._example-001.pdf']);
  await assertClean(Object.values(files)[0]);
});

function streamPdf(contents, entries = {}) {
  const packed = entries.Filter === 'FlateDecode' ? deflateSync(contents) : contents;
  const extras = Object.entries(entries).map(([key, value]) => `/${key} ${typeof value === 'number' ? value : value.startsWith('[') ? value : '/' + value}`).join(' ');
  return Buffer.concat([
    Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n4 0 obj\n<< ' + extras + ` /Length ${packed.length} >>\nstream\n`),
    packed, Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R /Size 1000 >>\n%%EOF'),
  ]);
}

test('bounded parser reads conventional and compressed cross-reference/object streams', async () => {
  const source = await PDFDocument.create(); source.addPage([240, 360]).drawText('fixture');
  for (const useObjectStreams of [true, false]) {
    const bytes = await source.save({ useObjectStreams });
    assert.equal((await loadLimitedPdf(bytes)).getPageCount(), 1);
    assert.deepEqual(await processPdfJob({ type: 'load', bytes }), [{ rotation: 0 }]);
  }
});

test('compressed object bomb is rejected before the per-stream allocation limit', async () => {
  const data = Buffer.alloc(2 * 1024 * 1024, 32); data.write('999 0 null');
  const bytes = streamPdf(data, { Type: 'ObjStm', N: 1, First: 6, Filter: 'FlateDecode' });
  const budget = createPdfBudget({ ...PDF_LIMITS, streamBytes: 64 * 1024 });
  await assert.rejects(loadLimitedPdf(bytes, budget), /安全上限.*展開量/);
  assert.ok(budget.allocated <= 64 * 1024);
});

test('nested filters cannot decompress before their individual allocation guards', async () => {
  const data = Buffer.alloc(512 * 1024, 32); data.write('999 0 null');
  const twice = deflateSync(deflateSync(data));
  const bytes = streamPdf(twice, { Type: 'ObjStm', N: 1, First: 6, Filter: '[/FlateDecode /FlateDecode]' });
  await assert.rejects(loadLimitedPdf(bytes, createPdfBudget({ ...PDF_LIMITS, streamBytes: 32 * 1024 })), /安全上限/);
});

test('forward referenced filters and oversized image decoder parameters cannot bypass limits', async () => {
  let bytes = streamPdf(Buffer.alloc(512 * 1024, 32), { Filter: 'FlateDecode' });
  bytes = Buffer.from(bytes.toString('latin1').replace('/Filter /FlateDecode', '/Filter 5 0 R').replace('trailer\n', '5 0 obj\n/FlateDecode\nendobj\ntrailer\n'), 'latin1');
  await assert.rejects(loadLimitedPdf(bytes, createPdfBudget({ ...PDF_LIMITS, streamBytes: 32 * 1024 })), /安全上限/);
  const image = streamPdf(Buffer.from('x'), { Subtype: 'Image', Width: 10, Height: 10, Filter: 'CCITTFaxDecode' });
  const malicious = Buffer.from(image.toString('latin1').replace('/Length 1', '/DecodeParms << /Columns 999999999 /Rows 99999999 >> /Length 1'), 'latin1');
  await assert.rejects(loadLimitedPdf(malicious), /予測フィルター/);
});

test('plain streams, object counts, image dimensions and dictionary depth are bounded', async () => {
  await assert.rejects(loadLimitedPdf(streamPdf(Buffer.alloc(4096)), createPdfBudget({ ...PDF_LIMITS, streamBytes: 1024 })), /安全上限/);
  await assert.rejects(loadLimitedPdf(streamPdf(Buffer.from('999 0 null'), { Type: 'ObjStm', N: 999999999, First: 6 })), /安全上限/);
  await assert.rejects(loadLimitedPdf(streamPdf(Buffer.from('x'), { Subtype: 'Image', Width: 999999, Height: 999999, Filter: 'DCTDecode' })), /画像ピクセル数/);
  const nested = streamPdf(Buffer.from('x')).toString('latin1').replace('/Size 1000', '/Deep ' + '[ '.repeat(80) + 'null ' + '] '.repeat(80));
  await assert.rejects(loadLimitedPdf(Buffer.from(nested, 'latin1')), /安全上限/);
});

test('cyclic page trees and expired parsing budgets fail without losing control', async () => {
  const cyclic = streamPdf(Buffer.from('x')).toString('latin1').replace('/Kids [3 0 R]', '/Kids [2 0 R]');
  await assert.rejects(loadLimitedPdf(Buffer.from(cyclic, 'latin1')), /ページ構造/);
  const parentCycle = streamPdf(Buffer.from('x')).toString('latin1').replace('/Parent 2 0 R', '/Parent 3 0 R');
  await assert.rejects(loadLimitedPdf(Buffer.from(parentCycle, 'latin1')), /親ページ参照/);
  const budget = createPdfBudget(); budget.started -= PDF_LIMITS.exportTimeout + 1;
  await assert.rejects(loadLimitedPdf(streamPdf(Buffer.from('x')), budget), /処理時間/);
});

test('cumulative decode allocations are bounded across multiple source documents', async () => {
  const budget = createPdfBudget({ ...PDF_LIMITS, streamBytes: 8192, decodedBytes: 12288 });
  const bytes = streamPdf(Buffer.alloc(8192, 32), { Filter: 'FlateDecode' });
  await loadLimitedPdf(bytes, budget);
  await assert.rejects(loadLimitedPdf(bytes, budget), /累計展開量/);
});

function mockWorker() {
  return { terminated: 0, postMessage(job) { this.job = job; }, terminate() { this.terminated++; } };
}

test('worker timeout terminates processing and subsequent operations can succeed', async () => {
  const stalled = mockWorker();
  await assert.rejects(runPdfJob({ type: 'load' }, { createWorker: () => stalled, timeout: 5 }), /処理時間/);
  assert.equal(stalled.terminated, 1);
  const next = mockWorker(), progress = [];
  const request = runPdfJob({ type: 'export' }, { createWorker: () => next, progress: (...value) => progress.push(value) });
  next.onmessage({ data: { type: 'progress', done: 1, total: 2 } });
  next.onmessage({ data: { type: 'result', result: 'complete' } });
  assert.equal(await request, 'complete'); assert.equal(next.terminated, 1);
  assert.deepEqual(progress, [[1, 2]]);
});

test('worker errors, abort and failed posting always release the worker', async () => {
  for (const kind of ['error', 'abort', 'posting', 'message']) {
    const worker = mockWorker(), controller = new AbortController();
    if (kind === 'posting') worker.postMessage = () => { throw new Error('posting failed'); };
    const request = runPdfJob({ type: 'load' }, { createWorker: () => worker, signal: controller.signal });
    if (kind === 'error') worker.onerror();
    if (kind === 'abort') controller.abort();
    if (kind === 'message') worker.onmessage({ data: { type: 'error', message: 'invalid input' } });
    await assert.rejects(request); assert.equal(worker.terminated, 1);
  }
});
