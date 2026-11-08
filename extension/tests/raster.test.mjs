import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, rgb } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPageOverlay, createPrintPages } from '../src/raster.js';
import { buildPdf } from '../src/pdf-export.js';
import { moveTextTail, textLayout } from '../src/pdf.js';
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

test('saved PDF and print rendering retain a moved tail and its translucent fill after rotation', async () => {
  const document = await PDFDocument.create(), page = document.addPage([200, 300]);
  page.drawRectangle({ x: 0, y: 0, width: 200, height: 300, color: rgb(0, 0, 1) });
  const preview = await pdfjs.getDocument({ data: await document.save() }).promise;
  const annotation = { tool: 'text', boxShape: 'bubble', text: 'Note\nPDF', rotation: 0, fontSize: 28,
    color: '#222222', backgroundColor: '#ffffff', backgroundOpacity: 0.5, points: [[45, 210]] };
  const record = { sourceId: 's', index: 0, rotation: 90, strokes: [annotation] };
  const sources = new Map([['s', { document, preview }]]);
  try {
    const view = (await preview.getPage(1)).getViewport({ scale: 2, rotation: 90 });
    const measure = createCanvas(1, 1).getContext('2d');
    const original = textLayout(measure, annotation, view);
    const moved = moveTextTail(measure, annotation, view, original.x - original.height / 2, original.y - 60);
    record.strokes = [moved];
    const saved = await pdfjs.getDocument({ data: await buildPdf([record], sources, createPageOverlay) }).promise;
    try {
      const exported = await saved.getPage(1), view = exported.getViewport({ scale: 2 });
      const canvas = createCanvas(view.width, view.height), ctx = canvas.getContext('2d');
      await exported.render({ canvasContext: ctx, viewport: view }).promise;
      const layout = textLayout(ctx, moved, view);
      assert.equal(layout.bubble.side, 3);
      assert.deepEqual(layout.bubble.tip, [original.x - original.height / 2, original.y - 60]);
      const pixelAt = (dx, dy) => {
        const x = Math.floor(layout.x + dx * Math.cos(layout.angle) - dy * Math.sin(layout.angle));
        const y = Math.floor(layout.y + dx * Math.sin(layout.angle) + dy * Math.cos(layout.angle));
        return [...ctx.getImageData(x, y, 1, 1).data];
      };
      const check = () => {
        const tail = pixelAt(-20, layout.height / 2);
        assert.ok([128, 128, 255, 255].every((value, channel) => Math.abs(tail[channel] - value) <= 2));
        assert.deepEqual(pixelAt(-20, layout.height * 0.8), [0, 0, 255, 255]);
        assert.deepEqual(pixelAt(layout.width / 2, layout.size * 0.03), [68, 68, 68, 255]);
      };
      check();
      const [printed] = await createPrintPages([record], sources);
      ctx.drawImage(await loadImage(Buffer.from(await printed.blob.arrayBuffer())), 0, 0);
      check();
    } finally { await saved.loadingTask.destroy(); }
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
