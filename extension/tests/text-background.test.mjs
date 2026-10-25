import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { textBackground, formatTextBackground, formatText, replaceText } from '../src/text-format.js';
import { paintOverlay, textLayout, buildPdf, imagePlacement } from '../src/pdf.js';

const original = { id: 'text', tool: 'text', text: 'WWW\n   ', fontSize: 24, bold: true, color: '#ff0000',
  points: [[150, 150]], rotation: 0 };
const pointInBox = (layout, dx, dy) => [Math.floor(layout.x + dx * Math.cos(layout.angle) - dy * Math.sin(layout.angle)),
  Math.floor(layout.y + dx * Math.sin(layout.angle) + dy * Math.cos(layout.angle))];

test('background defaults preserve legacy text, partial styles and plain-text edits', () => {
  assert.deepEqual(textBackground(original), { color: 'none', opacity: 1 });
  assert.deepEqual(formatTextBackground(original, { backgroundColor: 'none', backgroundOpacity: 1 }), original);
  const rich = formatText(original, 1, 2, { fontSize: 36, bold: true });
  const changed = formatTextBackground(rich, { backgroundColor: '#000000', backgroundOpacity: 0.5 });
  assert.equal(changed.runs, rich.runs); assert.equal(changed.text, rich.text);
  assert.equal(formatText(changed, 0, 1, { italic: true }).backgroundOpacity, 0.5);
  assert.equal(replaceText(changed, 'WWW!\n   ').backgroundColor, '#000000');
  assert.equal(textBackground({ backgroundColor: '#ff0000', backgroundOpacity: -1 }).color, 'none');
  assert.equal(textBackground({ backgroundOpacity: 2 }).opacity, 1);
});

test('white and black backgrounds fill the rotated box at each opacity without fading text or enlarging bounds', () => {
  for (const color of ['#ffffff', '#000000']) for (const opacity of [0, 0.25, 1]) {
    for (const rotation of [0, 90, 180, 270]) for (const scale of [0.5, 2]) {
      const canvas = createCanvas(600, 800), ctx = canvas.getContext('2d');
      const viewport = { width: 600, height: 800, scale, rotation, convertToViewportPoint: (x, y) => [x, y] };
      const annotation = { ...original, backgroundColor: color, backgroundOpacity: opacity };
      const layout = textLayout(ctx, annotation, viewport);
      assert.deepEqual(layout, textLayout(ctx, original, viewport));
      paintOverlay(ctx, { strokes: [annotation] }, viewport);
      const point = pointInBox(layout, layout.width - 2, layout.height - 2);
      const actual = [...ctx.getImageData(...point, 1, 1).data];
      assert.ok(Math.abs(actual[3] - opacity * 255) <= 1);
      if (opacity) assert.deepEqual(actual.slice(0, 3), color === '#ffffff' ? [255, 255, 255] : [0, 0, 0]);
      const outside = pointInBox(layout, layout.width + 3, layout.height - 2);
      assert.equal(ctx.getImageData(...outside, 1, 1).data[3], 0);
      const baseline = createCanvas(600, 800), baselineCtx = baseline.getContext('2d');
      paintOverlay(baselineCtx, { strokes: [original] }, viewport);
      const glyphs = baselineCtx.getImageData(0, 0, 600, 800).data;
      const pixels = ctx.getImageData(0, 0, 600, 800).data;
      let sample = 0;
      for (let i = 0; i < glyphs.length; i += 4) if (glyphs[i + 3] > glyphs[sample + 3]) sample = i;
      assert.ok(glyphs[sample + 3] > 128);
      const alpha = glyphs[sample + 3] / 255, compositeAlpha = alpha + opacity * (1 - alpha);
      const back = color === '#ffffff' ? 255 : 0;
      const expected = [255, 0, 0].map(channel => (channel * alpha + back * opacity * (1 - alpha)) / compositeAlpha);
      assert.ok(expected.every((channel, index) => Math.abs(pixels[sample + index] - channel) <= 2), 'text keeps its original coverage over the background');
      assert.ok(Math.abs(pixels[sample + 3] - compositeAlpha * 255) <= 1);
    }
  }
});

test('saved PDFs composite white and black backgrounds over original content at 0%, 50% and 100% opacity', async () => {
  const document = await PDFDocument.create();
  document.addPage([400, 400]).drawRectangle({ x: 0, y: 0, width: 400, height: 400, color: rgb(0.2, 0.4, 0.6) });
  const source = await pdfjs.getDocument({ data: await document.save() }).promise;
  try {
    const page = await source.getPage(1);
    for (const rotation of [0, 90]) for (const color of ['#ffffff', '#000000']) for (const opacity of [0, 0.5, 1]) {
      const viewport = page.getViewport({ scale: 1, rotation });
      const annotation = { ...original, backgroundColor: color, backgroundOpacity: opacity };
      const record = { id: 'page', sourceId: 'source', index: 0, rotation, strokes: [annotation] };
      const overlay = createCanvas(400, 400);
      paintOverlay(overlay.getContext('2d'), record, viewport);
      const bytes = await buildPdf([record], new Map([['source', { document, preview: source }]]), async () => ({
        bytes: new Uint8Array(overlay.toBuffer('image/png')), placement: imagePlacement(viewport),
      }));
      const output = await pdfjs.getDocument({ data: bytes }).promise;
      try {
        const exported = await output.getPage(1), actual = createCanvas(400, 400);
        await exported.render({ canvasContext: actual.getContext('2d'), viewport: exported.getViewport({ scale: 1 }) }).promise;
        const layout = textLayout(overlay.getContext('2d'), annotation, viewport);
        const point = pointInBox(layout, layout.width - 2, layout.height - 2);
        const pixel = [...actual.getContext('2d').getImageData(...point, 1, 1).data];
        const value = color === '#ffffff' ? 255 : 0;
        const expected = [51, 102, 153].map(channel => channel * (1 - opacity) + value * opacity);
        assert.ok(expected.every((channel, index) => Math.abs(pixel[index] - channel) <= 2), `${rotation}, ${color}, ${opacity}: ${pixel}`);
        assert.equal(pixel[3], 255);
      } finally { await output.loadingTask.destroy(); }
    }
  } finally { await source.loadingTask.destroy(); }
});
