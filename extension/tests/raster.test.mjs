import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, rgb } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPageOverlay, createPrintPages } from '../src/raster.js';
import { buildPdf } from '../src/pdf-export.js';
import { loadLimitedPdf } from '../src/pdf-security.js';

const canvases = [];
globalThis.document = { createElement(tag) {
  assert.equal(tag, 'canvas');
  const canvas = createCanvas(1, 1);
  // Native test canvases turn zero into a default size. Record the requested
  // reset separately while keeping their real drawing implementation intact.
  for (const key of ['width', 'height']) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(canvas), key);
    Object.defineProperty(canvas, key, {
      get() { return descriptor.get.call(this); },
      set(value) { this[`requested${key}`] = value; descriptor.set.call(this, value); },
    });
  }
  canvas.toBlob = callback => callback(new Blob([canvas.toBuffer('image/png')], { type: 'image/png' }));
  canvases.push(canvas); return canvas;
} };

test('raster service preserves overlay placement and print composition and releases canvas buffers', async () => {
  const document = await PDFDocument.create(), page = document.addPage([200, 300]);
  page.drawRectangle({ x: 15, y: 20, width: 25, height: 30, color: rgb(0, 0, 1) });
  const preview = await pdfjs.getDocument({ data: await document.save() }).promise;
  const record = { sourceId: 's', index: 0, rotation: 90, watermark: null,
    strokes: [{ tool: 'pen', color: '#ff0000', width: 10, opacity: 1, points: [[100, 150], [150, 150]] }] };
  const sources = new Map([['s', { document, preview }]]);
  try {
    const bytes = await buildPdf([record], sources, createPageOverlay);
    const output = await PDFDocument.load(bytes);
    assert.equal(output.getPage(0).getRotation().angle, 90);
    const printed = await createPrintPages([record], sources);
    assert.deepEqual([printed[0].width, printed[0].height], [300, 200]);
    const image = await loadImage(Buffer.from(await printed[0].blob.arrayBuffer()));
    const canvas = createCanvas(image.width, image.height), ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0, blue = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 200 && data[i + 1] < 50 && data[i + 2] < 50) red++;
      if (data[i + 2] > 200 && data[i] < 50 && data[i + 1] < 50) blue++;
    }
    assert.ok(red > 50 && blue > 50);
    assert.ok(canvases.every(canvas => canvas.requestedwidth === 0 && canvas.requestedheight === 0));
  } finally { await preview.loadingTask.destroy(); }
});

test('raster service frees both canvases after rendering errors', async () => {
  const start = canvases.length;
  const sources = new Map([['s', { preview: { async getPage() { return {
    getViewport: () => ({ width: 200, height: 300 }), render: () => ({ promise: Promise.reject(new Error('render failed')) }),
  }; } } }]]);
  await assert.rejects(createPrintPages([{ sourceId: 's', index: 0 }], sources), /render failed/);
  assert.ok(canvases.slice(start).every(canvas => canvas.requestedwidth === 0 && canvas.requestedheight === 0));
});

test('bounded parser accepts standard PNG predictors, JPEG images and image masks', async () => {
  const canvas = createCanvas(100, 100); canvas.getContext('2d').fillRect(0, 0, 50, 50);
  const document = await PDFDocument.create(), page = document.addPage([240, 360]);
  const png = await document.embedPng(canvas.toBuffer('image/png'));
  const jpeg = await document.embedJpg(canvas.toBuffer('image/jpeg'));
  page.drawImage(png, { x: 0, y: 0, width: 50, height: 50 });
  page.drawImage(jpeg, { x: 80, y: 80, width: 50, height: 50 });
  assert.equal((await loadLimitedPdf(await document.save())).getPageCount(), 1);
});
