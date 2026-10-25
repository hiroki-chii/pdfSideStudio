import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { PDFDocument } from 'pdf-lib';
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

test('real Worker rejects invalid input and a later import still works', async () => {
  await assert.rejects(runPdfJob({ type: 'load', bytes: new Uint8Array([1, 2, 3]) }, { createWorker }));
  const source = await PDFDocument.create(); source.addPage();
  assert.equal((await runPdfJob({ type: 'load', bytes: await source.save() }, { createWorker })).length, 1);
});
