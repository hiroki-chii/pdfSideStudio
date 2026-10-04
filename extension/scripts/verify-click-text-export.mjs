import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

// Add dark, multiline text to both pages of tmp/sample-a.pdf through the UI,
// then save while the second page's text box is still being edited.
const path = process.argv[2];
if (!path) throw new Error('Pass the PDF saved by the click-to-insert UI test.');
const bytes = new Uint8Array(await readFile(path));
const document = await PDFDocument.load(bytes);
assert.equal(document.getPageCount(), 2);
assert.deepEqual(document.getPages().map(page => page.getRotation().angle), [0, 90]);
const saved = await pdfjs.getDocument({ data: bytes, useSystemFonts: true }).promise;
const original = await pdfjs.getDocument({ data: new Uint8Array(await readFile('tmp/sample-a.pdf')), useSystemFonts: true }).promise;
try {
  for (let number = 1; number <= 2; number++) {
    const pages = await Promise.all([saved.getPage(number), original.getPage(number)]);
    const texts = await Promise.all(pages.map(async page => (await page.getTextContent()).items.map(item => item.str).join(' ')));
    assert.equal(texts[0], texts[1], 'Original searchable text must be retained');
    const canvases = [];
    for (const page of pages) {
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      canvases.push(canvas);
    }
    const [after, before] = canvases.map(canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);
    let addedTextPixels = 0;
    for (let offset = 0; offset < after.length; offset += 4) {
      if (Math.max(...after.slice(offset, offset + 3)) < 120 && Math.min(...before.slice(offset, offset + 3)) > 180) addedTextPixels++;
    }
    assert.ok(addedTextPixels > 100, `Page ${number}: inserted text missing (${addedTextPixels} pixels)`);
    await writeFile(`tmp/click-text-export-${number}.png`, canvases[0].toBuffer('image/png'));
    console.log(`Page ${number}: original text retained, ${addedTextPixels} added text pixels.`);
  }
} finally {
  await saved.loadingTask.destroy();
  await original.loadingTask.destroy();
}
