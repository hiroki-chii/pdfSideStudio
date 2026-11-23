import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, rgb } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPageOverlay, createPrintPages } from '../src/raster.js';
import { buildPdf } from '../src/pdf-export.js';
import { moveTextTail, paintOverlay, textLayout } from '../src/pdf.js';
import { loadLimitedPdf } from '../src/pdf-security.js';
import { createImageAnnotation, imageLayout, moveImage, prepareOverlayImages, resizeImageFromHandle, restoreImageAspectRatio } from '../src/image-overlay.js';

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

test('preview, saved PDF and print use the chosen watermark size and paint it above images at 20% opacity', async t => {
  globalThis.createImageBitmap = async blob => loadImage(Buffer.from(await blob.arrayBuffer()));
  t.after(() => { delete globalThis.createImageBitmap; });
  const document = await PDFDocument.create();
  document.addPage([200, 200]);
  const preview = await pdfjs.getDocument({ data: await document.save() }).promise;
  t.after(() => preview.loadingTask.destroy());
  const view = (await preview.getPage(1)).getViewport({ scale: 2 });
  const tile = createCanvas(200, 200), tileContext = tile.getContext('2d');
  tileContext.fillStyle = '#0000ff';
  tileContext.fillRect(0, 0, tile.width, tile.height);
  const blob = new Blob([tile.toBuffer('image/png')], { type: 'image/png' });
  const image = { ...createImageAnnotation('image', { blob, width: 200, height: 200 }, view), width: 200, height: 200 };
  const watermark = { text: 'DRAFT', color: '#ff0000', opacity: 1 };
  const original = { sourceId: 's', index: 0, rotation: 0, strokes: [image], watermark };
  const sources = new Map([['s', { document, preview }]]);
  const canvas = createCanvas(view.width, view.height), context = canvas.getContext('2d');
  const countRed = () => {
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - 51) <= 3 && data[i + 1] <= 2 && Math.abs(data[i + 2] - 204) <= 3) count++;
    }
    return count;
  };
  await prepareOverlayImages(original);
  paintOverlay(context, original, view);
  const standardPixels = countRed();
  for (const record of [original, { ...original, layerOrder: ['watermark', 'image'] },
    { ...original, layerOrder: ['image', 'watermark'], watermark: { ...watermark, opacity: 0.05, position: 'bottom-right' } },
    { ...original, watermark: { ...watermark, fontSize: 64 } }]) {
    paintOverlay(context, record, view);
    const expected = countRed();
    assert.ok(expected > 200);
    if (record.watermark.fontSize) assert.ok(expected > standardPixels * 1.5);
    const saved = await pdfjs.getDocument({ data: await buildPdf([record], sources, createPageOverlay) }).promise;
    try {
      const page = await saved.getPage(1);
      await page.render({ canvasContext: context, viewport: view }).promise;
      assert.ok(Math.abs(countRed() - expected) < 10);
    } finally { await saved.loadingTask.destroy(); }
    const [printed] = await createPrintPages([record], sources);
    context.drawImage(await loadImage(Buffer.from(await printed.blob.arrayBuffer())), 0, 0);
    assert.equal(countRed(), expected);
  }
});

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

test('pasted images preserve their rotated bounds, intrinsic alpha and adjustable opacity in saved PDFs and print', async t => {
  globalThis.createImageBitmap = async blob => loadImage(Buffer.from(await blob.arrayBuffer()));
  t.after(() => { delete globalThis.createImageBitmap; });
  const background = createCanvas(200, 300), backgroundContext = background.getContext('2d');
  backgroundContext.fillStyle = '#0000ff';
  backgroundContext.fillRect(0, 0, 200, 300);
  const document = await PDFDocument.create();
  document.addPage([200, 300]).drawImage(await document.embedPng(background.toBuffer('image/png')),
    { x: 0, y: 0, width: 200, height: 300 });
  const preview = await pdfjs.getDocument({ data: await document.save() }).promise;
  t.after(() => preview.loadingTask.destroy());

  const sticker = createCanvas(80, 40), stickerContext = sticker.getContext('2d');
  stickerContext.fillStyle = '#ff0000';
  stickerContext.fillRect(0, 0, 40, 40);
  const blob = new Blob([sticker.toBuffer('image/png')], { type: 'image/png' });
  const page = await preview.getPage(1);
  const originalView = page.getViewport({ scale: 1, rotation: 0 });
  const original = createImageAnnotation('sticker', { blob, width: 80, height: 40 }, originalView);
  assert.deepEqual([original.width, original.height], [80, 40]);
  const rotatedView = page.getViewport({ scale: 2, rotation: 90 });
  const moved = moveImage(original, rotatedView, -1000, -1000);
  const resized = resizeImageFromHandle(moved, rotatedView, [1, 1], 20, 40);
  assert.deepEqual([resized.width, resized.height], [100, 50]);
  const stretched = resizeImageFromHandle(resized, rotatedView, [1, 0], 40, 0);
  assert.deepEqual([stretched.width, stretched.height], [100, 70]);
  const layout = imageLayout(stretched, rotatedView);
  assert.deepEqual([layout.left, layout.top, layout.angle], [0, 0, Math.PI / 2]);
  const legacy = { ...stretched };
  delete legacy.originalAspectRatio;
  await prepareOverlayImages({ strokes: [legacy] });
  const restored = restoreImageAspectRatio(legacy);
  assert.deepEqual([restored.width, restored.height], [100, 50]);
  assert.deepEqual(restored.points, legacy.points);

  const sources = new Map([['s', { document, preview }]]);
  const canvas = createCanvas(rotatedView.width, rotatedView.height), context = canvas.getContext('2d');
  const checkPixels = expected => {
    for (const x of [50, 125]) {
      const pixel = [...context.getImageData(x, 50, 1, 1).data];
      assert.ok(pixel.every((value, channel) => Math.abs(value - expected[channel]) <= 2), `${pixel} ≈ ${expected}`);
    }
    assert.deepEqual([...context.getImageData(50, 150, 1, 1).data], [0, 0, 255, 255]);
    assert.deepEqual([...context.getImageData(150, 50, 1, 1).data], [0, 0, 255, 255]);
  };
  for (const [annotation, expected] of [[stretched, [255, 0, 0, 255]],
    [{ ...stretched, opacity: 0.5 }, [128, 0, 128, 255]], [{ ...stretched, opacity: 0 }, [0, 0, 255, 255]]]) {
    const record = structuredClone({ sourceId: 's', index: 0, rotation: 90, strokes: [annotation] });
    const saved = await pdfjs.getDocument({ data: await buildPdf([record], sources, createPageOverlay) }).promise;
    try {
      const exported = await saved.getPage(1);
      await exported.render({ canvasContext: context, viewport: exported.getViewport({ scale: 2 }) }).promise;
      checkPixels(expected);
    } finally { await saved.loadingTask.destroy(); }
    const [printed] = await createPrintPages([record], sources);
    context.drawImage(await loadImage(Buffer.from(await printed.blob.arrayBuffer())), 0, 0);
    checkPixels(expected);
  }
});

test('dragging any image corner keeps the opposite corner fixed across viewport rotations and zoom', async t => {
  const document = await PDFDocument.create();
  document.addPage([200, 300]);
  const preview = await pdfjs.getDocument({ data: await document.save() }).promise;
  t.after(() => preview.loadingTask.destroy());
  const page = await preview.getPage(1);
  const original = createImageAnnotation('sticker', { width: 80, height: 40 }, page.getViewport({ scale: 1 }));
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≈ ${expected}`);
  for (const rotation of [0, 90, 180, 270]) {
    for (const scale of [0.5, 2]) {
      const view = page.getViewport({ scale, rotation });
      const { left, top, right, bottom } = imageLayout(original, view);
      for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const corner = [x, y];
        const dx = x * (right - left), dy = y * (bottom - top);
        assert.equal(resizeImageFromHandle(original, view, corner, 0, 0), original);
        for (const factor of [-10, -0.25, 0.25, 10]) {
          const resized = resizeImageFromHandle(original, view, corner, dx * factor, dy * factor);
          const bounds = imageLayout(resized, view);
          close(x < 0 ? bounds.right : bounds.left, x < 0 ? right : left);
          close(y < 0 ? bounds.bottom : bounds.top, y < 0 ? bottom : top);
          close(resized.width / resized.height, original.width / original.height);
          assert.ok(bounds.left >= -1e-6 && bounds.top >= -1e-6);
          assert.ok(bounds.right <= view.width + 1e-6 && bounds.bottom <= view.height + 1e-6);
          if (Math.abs(factor) < 1) close(resized.width, original.width * (1 + factor));
          if (factor === -10) close(resized.width, 1);
        }
      }
    }
  }
});

test('dragging an image edge changes one dimension and keeps the opposite edge fixed across rotation and zoom', async t => {
  const document = await PDFDocument.create();
  document.addPage([200, 300]);
  const preview = await pdfjs.getDocument({ data: await document.save() }).promise;
  t.after(() => preview.loadingTask.destroy());
  const page = await preview.getPage(1);
  const original = createImageAnnotation('sticker', { width: 80, height: 40 }, page.getViewport({ scale: 1 }));
  for (const rotation of [0, 90, 180, 270]) {
    for (const scale of [0.5, 2]) {
      const view = page.getViewport({ scale, rotation });
      const { left, top, right, bottom } = imageLayout(original, view);
      for (const direction of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const [x, y] = direction;
        assert.equal(resizeImageFromHandle(original, view, direction, y * 50, x * 50), original);
        const resized = imageLayout(resizeImageFromHandle(original, view, direction, x * 20 + y * 50, y * 20 + x * 50), view);
        assert.deepEqual([resized.left, resized.top, resized.right, resized.bottom],
          [left + Math.min(0, x) * 20, top + Math.min(0, y) * 20, right + Math.max(0, x) * 20, bottom + Math.max(0, y) * 20]);
        const atPageEdge = imageLayout(resizeImageFromHandle(original, view, direction, x * 1000, y * 1000), view);
        assert.deepEqual([atPageEdge.left, atPageEdge.top, atPageEdge.right, atPageEdge.bottom],
          [x < 0 ? 0 : left, y < 0 ? 0 : top, x > 0 ? view.width : right, y > 0 ? view.height : bottom]);
        const reduced = imageLayout(resizeImageFromHandle(original, view, direction, -x * 1000, -y * 1000), view);
        assert.deepEqual([reduced.right - reduced.left, reduced.bottom - reduced.top],
          [x ? scale : right - left, y ? scale : bottom - top]);
      }
    }
  }
});

test('restoring image proportions fits the original ratio inside the current frame and preserves other image properties', () => {
  const viewport = { width: 200, height: 300, scale: 1, rotation: 90, convertToPdfPoint: (x, y) => [x, y] };
  const blob = new Blob();
  const original = createImageAnnotation('sticker', { blob, width: 40.5, height: 20.25 }, viewport);
  assert.equal(restoreImageAspectRatio(original), original);
  for (const [width, height, expectedWidth, expectedHeight] of [[120, 40, 80, 40], [80, 60, 80, 40], [60, 40, 60, 30], [80, 30, 60, 30]]) {
    const changed = { ...original, width, height, opacity: 0.4, points: [[87, 130]] };
    const restored = restoreImageAspectRatio(changed);
    assert.deepEqual(restored, { ...changed, width: expectedWidth, height: expectedHeight });
    assert.equal(restoreImageAspectRatio(restored), restored);
  }
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
