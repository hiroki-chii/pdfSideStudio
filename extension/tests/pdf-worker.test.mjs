import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { runPdfJob } from '../src/pdf-processor.js';

function createWorker() {
  const thread = new Worker(new URL('./helpers/pdf-worker-host.mjs', import.meta.url), {
    workerData: { module: new URL('../src/pdf-worker.js', import.meta.url).href },
  });
  const adapter = { postMessage: message => thread.postMessage(message), terminate: () => thread.terminate() };
  thread.on('message', data => adapter.onmessage?.({ data }));
  thread.on('error', error => adapter.onerror?.(error));
  return adapter;
}

test('real dedicated Worker imports and exports the PDF protocol with structured cloning', async () => {
  const source = await PDFDocument.create(); source.addPage([240, 360]).drawText('Worker fixture');
  const bytes = await source.save();
  assert.deepEqual(await runPdfJob({ type: 'load', bytes }, { createWorker }), [{ rotation: 0 }]);
  const output = await runPdfJob({ type: 'export', sources: [{ id: 's', bytes }],
    records: [{ sourceId: 's', index: 0, rotation: 90, strokes: [], watermark: null }] }, { createWorker });
  const result = await PDFDocument.load(output);
  assert.equal(result.getPageCount(), 1); assert.equal(result.getPage(0).getRotation().angle, 90);
  // Worker input cloning must not detach the editor's original bytes.
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
});

test('real Worker imports an A4 600 dpi JPEG scan and preserves its image on PDF export', async () => {
  const canvas = createCanvas(4961, 7016);
  const context = canvas.getContext('2d');
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const jpeg = canvas.toBuffer('image/jpeg');
  const source = await PDFDocument.create();
  const page = source.addPage([595, 842]);
  page.drawImage(await source.embedJpg(jpeg), { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  const bytes = await source.save();

  assert.deepEqual(await runPdfJob({ type: 'load', bytes }, { createWorker }), [{ rotation: 0 }]);
  const output = await runPdfJob({ type: 'export', sources: [{ id: 's', bytes }],
    records: [{ sourceId: 's', index: 0, rotation: 0, strokes: [], watermark: null }] }, { createWorker });
  const saved = await PDFDocument.load(output);
  const image = saved.context.enumerateIndirectObjects().map(([, object]) => object)
    .find(object => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
  assert.ok(image);
  assert.deepEqual(Buffer.from(image.getContents()), jpeg);
});

test('real Worker rejects invalid input and a later import still works', async () => {
  await assert.rejects(runPdfJob({ type: 'load', bytes: new Uint8Array([1, 2, 3]) }, { createWorker }));
  const source = await PDFDocument.create(); source.addPage();
  assert.equal((await runPdfJob({ type: 'load', bytes: await source.save() }, { createWorker })).length, 1);
});
