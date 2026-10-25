import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_PAGES } from '../src/model.js';
import { PDF_LIMITS, PdfLimitError } from '../src/limits.js';

const script = (await readFile(new URL('../src/pdf-source.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
function setup({ previewError, pageCount = 1 } = {}) {
  const calls = [], file = { name: 'test.pdf', type: 'application/pdf', size: 100,
    async arrayBuffer() { calls.push('read'); return new ArrayBuffer(100); } };
  const context = vm.createContext({ URL, Uint8Array, setTimeout, clearTimeout, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_PAGES, PDF_LIMITS, PdfLimitError,
    workerUrl: 'local-worker', document: { baseURI: 'https://example.test/' },
    runPdfJob: async () => { calls.push('inspect'); return Array.from({ length: pageCount }, () => ({ rotation: 0 })); },
    pdfjs: { GlobalWorkerOptions: {}, getDocument(options) {
      calls.push(options);
      return { promise: previewError ? Promise.reject(new Error('preview failed')) : Promise.resolve({ numPages: pageCount }),
        async destroy() { calls.push('destroy'); } };
    } },
  });
  vm.runInContext(script, context);
  return { context, calls, file };
}

test('source reader validates inputs before reading bytes or creating preview workers', async () => {
  const { context, calls, file } = setup();
  for (const [input, options] of [
    [{ ...file, name: 'x.html', type: 'text/html' }, { usedBytes: 0, pageCount: 0 }],
    [{ ...file, size: MAX_FILE_BYTES + 1 }, { usedBytes: 0, pageCount: 0 }],
    [file, { usedBytes: MAX_TOTAL_BYTES, pageCount: 0 }],
  ]) await assert.rejects(context.readPdfSource(input, options));
  assert.equal(calls.length, 0);
});

test('source reader uses local assets and rejects excess pages before preview loading', async () => {
  const { context, calls, file } = setup({ pageCount: 2 });
  await assert.rejects(context.readPdfSource(file, { usedBytes: 0, pageCount: MAX_PAGES - 1 }), /ページを超えます/);
  assert.deepEqual(calls, ['read', 'inspect']); calls.length = 0;
  const result = await context.readPdfSource(file, { usedBytes: 0, pageCount: 0 });
  assert.equal(result.pages.length, 2); assert.equal(result.bytes.length, 100);
  const options = calls[2];
  assert.equal(options.isEvalSupported, false);
  assert.equal(options.cMapUrl, 'https://example.test/cmaps/');
  assert.equal(options.maxImageSize, PDF_LIMITS.imagePixels);
  assert.equal(options.enableXfa, false);
});

test('failed preview loading destroys the failed document without retaining a source', async () => {
  const { context, calls, file } = setup({ previewError: true });
  await assert.rejects(context.readPdfSource(file, { usedBytes: 0, pageCount: 0 }), /preview failed/);
  assert.equal(calls.at(-1), 'destroy');
});
