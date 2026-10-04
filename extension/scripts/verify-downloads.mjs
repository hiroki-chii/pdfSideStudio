import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import { unzipSync } from 'fflate';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const directory = process.argv[2];
if (!directory) throw new Error('Pass the directory containing the UI test downloads.');
const combined = new Uint8Array(await readFile(join(directory, 'sample-a.pdf')));
const doc = await PDFDocument.load(combined);
assert.equal(doc.getPageCount(), 3);
assert.deepEqual(doc.getPages().map(page => page.getRotation().angle), [0, 90, 0]);
for (const page of doc.getPages()) assert.ok(page.node.Resources().lookup(PDFName.of('XObject')).keys().length > 0);
const zip = unzipSync(new Uint8Array(await readFile(join(directory, 'sample-a-pages.zip'))));
assert.deepEqual(Object.keys(zip), ['sample-a-001.pdf', 'sample-a-002.pdf', 'sample-a-003.pdf']);
for (const [index, bytes] of Object.values(zip).entries()) {
  const part = await PDFDocument.load(bytes);
  assert.equal(part.getPageCount(), 1);
  assert.equal(part.getPage(0).getRotation().angle, doc.getPage(index).getRotation().angle);
}
const loading = pdfjs.getDocument({ data: combined, useSystemFonts: true });
const preview = await loading.promise;
const page = await preview.getPage(1);
const text = (await page.getTextContent()).items.map(item => item.str).join(' ');
assert.ok(text.includes('DESIGN NOTES'));
const view = page.getViewport({ scale: 1.5 });
const canvas = createCanvas(view.width, view.height);
await page.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise;
const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
let redPixels = 0;
for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 170 && pixels[i + 1] < 150 && pixels[i + 2] < 170) redPixels++;
assert.ok(redPixels > 30, `Expected saved pen strokes; found ${redPixels} red pixels.`);
await mkdir('tmp', { recursive: true });
await writeFile('tmp/exported-page.png', canvas.toBuffer('image/png'));
await loading.destroy();
console.log(`UI downloads verified: merged 3 pages; ZIP contains 3 single-page PDFs; text preserved; ${redPixels} red pen pixels.`);
