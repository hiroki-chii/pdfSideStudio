import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const savedPath = process.argv[2];
if (!savedPath) throw new Error('Pass the PDF saved by the rectangle/text UI test.');
const bytes = new Uint8Array(await readFile(savedPath));
const document = await PDFDocument.load(bytes);
assert.equal(document.getPageCount(), 2);
assert.deepEqual(document.getPages().map(page => page.getRotation().angle), [0, 90]);
const exported = await pdfjs.getDocument({ data: bytes, useSystemFonts: true }).promise;
const original = await pdfjs.getDocument({ data: new Uint8Array(await readFile('tmp/sample-a.pdf')), useSystemFonts: true }).promise;
const render = async page => {
  const viewport = page.getViewport({ scale: 1.5 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas;
};
for (let index = 1; index <= 2; index++) {
  const page = await exported.getPage(index);
  const originalPage = await original.getPage(index);
  const savedText = (await page.getTextContent()).items.map(item => item.str).join(' ');
  const originalText = (await originalPage.getTextContent()).items.map(item => item.str).join(' ');
  assert.equal(savedText, originalText, 'Original searchable text must be retained');
  const saved = await render(page); const base = await render(originalPage);
  const after = saved.getContext('2d').getImageData(0, 0, saved.width, saved.height).data;
  const before = base.getContext('2d').getImageData(0, 0, base.width, base.height).data;
  let addedTextPixels = 0; let redPixels = 0;
  for (let offset = 0; offset < after.length; offset += 4) {
    if (Math.max(...after.slice(offset, offset + 3)) < 120 && Math.min(...before.slice(offset, offset + 3)) > 180) addedTextPixels++;
    if (after[offset] > 170 && after[offset + 1] < 150 && after[offset + 2] < 170) redPixels++;
  }
  assert.ok(addedTextPixels > 40, `Page ${index}: expected inserted dark text, found ${addedTextPixels} pixels`);
  if (index === 1) assert.ok(redPixels > 100, 'Expected saved rectangle outlines');
  await writeFile(`tmp/rectangle-text-export-${index}.png`, saved.toBuffer('image/png'));
  console.log(`Page ${index}: original text retained, ${addedTextPixels} added text pixels, ${redPixels} red pixels.`);
}
await exported.loadingTask.destroy(); await original.loadingTask.destroy();
