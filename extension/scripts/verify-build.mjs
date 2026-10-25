import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { PDFDocument, PDFName } from 'pdf-lib';
import { unzipSync } from 'fflate';
import { runPdfJob } from '../src/pdf-processor.js';

const assets = await readdir(new URL('../dist/assets/', import.meta.url));
const entry = assets.find(file => /^pdf-worker-.*\.js$/.test(file));
assert.ok(entry, 'Dedicated PDF worker must be bundled');
const moduleUrl = new URL(`../dist/assets/${entry}`, import.meta.url).href;
const createWorker = () => {
  const thread = new Worker(new URL('../tests/helpers/pdf-worker-host.mjs', import.meta.url), { workerData: { module: moduleUrl } });
  const adapter = { postMessage: message => thread.postMessage(message), terminate: () => thread.terminate() };
  thread.on('message', data => adapter.onmessage?.({ data }));
  thread.on('error', error => adapter.onerror?.(error));
  return adapter;
};
const source = await PDFDocument.create();
const first = source.addPage([240, 360]), excluded = source.addPage([300, 400]);
first.drawText('visible build fixture'); excluded.drawText('EXCLUDED_BUILD_SECRET');
first.node.set(PDFName.of('Annots'), source.context.obj([source.context.obj({ Subtype: 'Link', Dest: [excluded.ref, PDFName.of('Fit')] })]));
const bytes = await source.save();
assert.equal((await runPdfJob({ type: 'load', bytes }, { createWorker })).length, 2);
const result = await runPdfJob({ type: 'export', sources: [{ id: 's', bytes }],
  records: [{ sourceId: 's', index: 0, rotation: 90, strokes: [], watermark: null }] }, { createWorker });
const output = await PDFDocument.load(result);
assert.equal(output.getPageCount(), 1);
assert.equal(output.getPage(0).getRotation().angle, 90);
assert.equal(output.getPage(0).node.get(PDFName.of('Annots')), undefined);
const manifestBytes = await readFile(new URL('../dist/manifest.json', import.meta.url));
const manifest = JSON.parse(manifestBytes);
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
assert.equal(manifest.version, packageJson.version);
assert.deepEqual(manifest.permissions, ['sidePanel']);
assert.match(manifest.content_security_policy.extension_pages, /connect-src 'self'/);
assert.match(manifest.content_security_policy.extension_pages, /worker-src 'self'/);
const archive = unzipSync(new Uint8Array(await readFile(new URL('../release/pdf-side-studio.zip', import.meta.url))));
assert.deepEqual(Buffer.from(archive['manifest.json']), manifestBytes);
for (const file of ['index.html', 'print.html', 'background.js', 'README.md', 'docs/architecture.md', 'docs/security-review-2026-10-25.md', ...assets.map(name => `assets/${name}`)]) {
  assert.deepEqual(Buffer.from(archive[file]), await readFile(new URL(`../dist/${file}`, import.meta.url)), `${file} differs in release ZIP`);
}
console.log('Bundled worker load/export, CSP, permissions and release ZIP contents verified.');
