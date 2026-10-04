import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFNumber, degrees, rgb } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { EditorModel, MAX_PAGES, normalizeRotation, safeFilename } from '../src/model.js';
import { buildPdf, imagePlacement, paintOverlay, textLayout, moveText, strokeLayout, moveStroke, watermarkLayout, moveWatermark } from '../src/pdf.js';

test('watermark movement follows viewport directions, clamps bounds and restores through history', async () => {
  const ctx = createCanvas(600, 800).getContext('2d');
  const doc = await PDFDocument.create(); doc.addPage([600, 800]);
  const preview = await pdfjs.getDocument({ data: await doc.save() }).promise;
  const page = await preview.getPage(1);
  for (const rotation of [0, 90, 180, 270]) {
    const viewport = page.getViewport({ scale: 1.5, rotation });
    const original = { text: 'DRAFT', color: '#736c90', opacity: 0.2 };
    const before = watermarkLayout(ctx, original, viewport);
    const moved = moveWatermark(ctx, original, viewport, 25, 40);
    const after = watermarkLayout(ctx, moved, viewport);
    assert.ok(Math.abs(after.cx - before.cx - 25) < 1e-8);
    assert.ok(Math.abs(after.cy - before.cy - 40) < 1e-8);
    assert.equal(original.points, undefined);
    const edge = watermarkLayout(ctx, moveWatermark(ctx, moved, viewport, 10000, -10000), viewport);
    assert.ok(edge.left >= -1e-8 && edge.right <= viewport.width + 1e-8);
    assert.ok(edge.top >= -1e-8 && edge.bottom <= viewport.height + 1e-8);
    const model = new EditorModel();
    model.commit([{ id: 'page', strokes: [], watermark: original }]);
    model.update(new Set(['page']), p => ({ ...p, watermark: moved }));
    model.undo(); assert.deepEqual(model.active.watermark, original);
    model.redo(); assert.deepEqual(model.active.watermark, moved);
    model.update(new Set(['page']), p => ({ ...p, watermark: null }));
    model.undo(); assert.deepEqual(model.active.watermark, moved);
  }
  await preview.loadingTask.destroy();
});

test('rotation and output filenames are normalized', () => {
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(450), 90);
  assert.equal(safeFilename('../a:b.pdf'), '.._a_b');
  assert.equal(safeFilename(' '), 'edited');
});

test('history restores content, branches on edit, and enforces page limit atomically', () => {
  const model = new EditorModel();
  const a = { id: 'a', rotation: 0, strokes: [] };
  model.commit([a], { activeId: 'a' });
  model.update(new Set(['a']), p => ({ ...p, rotation: 90 }));
  assert.equal(a.rotation, 0);
  model.commit([]);
  model.undo(); assert.equal(model.active.rotation, 90);
  model.undo(); assert.equal(model.active.rotation, 0);
  model.redo(); assert.equal(model.active.rotation, 90);
  model.undo(); model.update(new Set(['a']), p => ({ ...p, rotation: 180 }));
  assert.equal(model.future.length, 0);
  assert.throws(() => model.commit(Array(MAX_PAGES + 1).fill(a)));
  assert.equal(model.pages.length, 1);
  for (let i = 0; i < 35; i++) model.update(new Set(['a']), p => ({ ...p, rotation: i }));
  assert.equal(model.past.length, 30);
});

test('merge, reorder, split, rotate and duplicate preserve original dimensions/content', async () => {
  const a = await PDFDocument.create(); a.addPage([200, 300]); a.addPage([400, 500]);
  const b = await PDFDocument.create(); b.addPage([600, 700]);
  const sources = new Map([['a', { document: a }], ['b', { document: b }]]);
  const record = (sourceId, index, rotation = 0) => ({ sourceId, index, rotation, strokes: [], watermark: null });
  const records = [record('b', 0, 90), record('a', 1), record('a', 0, 270), record('a', 0)];
  const output = await PDFDocument.load(await buildPdf(records, sources));
  assert.deepEqual(output.getPages().map(p => p.getSize()), [{ width: 600, height: 700 }, { width: 400, height: 500 }, { width: 200, height: 300 }, { width: 200, height: 300 }]);
  assert.deepEqual(output.getPages().map(p => p.getRotation().angle), [90, 0, 270, 0]);
  assert.equal(a.getPage(0).getRotation().angle, 0);
  for (const record of records) assert.equal((await PDFDocument.load(await buildPdf([record], sources))).getPageCount(), 1);
  await assert.rejects(buildPdf([], sources));
});

test('drag reorder preserves page edits and active page; undo/redo restore order', async () => {
  const doc = await PDFDocument.create();
  for (const width of [100, 200, 300, 400]) doc.addPage([width, 500]);
  const pages = ['a', 'b', 'c', 'd'].map((id, index) => ({ id, sourceId: 'source', index, rotation: 0, strokes: [], watermark: null }));
  pages[1].strokes = [{ color: '#e05267', width: 3, points: [[1, 2], [3, 4]] }];
  pages[1].watermark = { text: '社外秘', color: '#736c90', opacity: 0.2 };
  const model = new EditorModel();
  model.commit(pages, { activeId: 'b' });
  assert.equal(model.moveBefore('a', null), true);
  assert.deepEqual(model.pages.map(p => p.id), ['b', 'c', 'd', 'a']);
  assert.equal(model.active, pages[1]);
  model.undo(); assert.deepEqual(model.pages.map(p => p.id), ['a', 'b', 'c', 'd']);
  model.redo(); assert.deepEqual(model.pages.map(p => p.id), ['b', 'c', 'd', 'a']);
  assert.equal(model.moveBefore('d', 'b'), true);
  assert.deepEqual(model.pages.map(p => p.id), ['d', 'b', 'c', 'a']);
  const output = await PDFDocument.load(await buildPdf(model.pages.filter(p => !p.strokes.length), new Map([['source', { document: doc }]])));
  assert.deepEqual(output.getPages().map(p => p.getWidth()), [400, 300, 100]);
});

test('unchanged or invalid drop does not create history or clear redo', () => {
  const model = new EditorModel();
  model.commit(['a', 'b', 'c'].map(id => ({ id })));
  model.moveBefore('c', 'a'); model.undo();
  const history = model.past.length;
  const future = model.future.length;
  for (const [id, beforeId] of [['a', 'a'], ['a', 'b'], ['c', null], ['missing', 'a'], ['a', 'missing']]) {
    assert.equal(model.moveBefore(id, beforeId), false);
    assert.deepEqual(model.pages.map(p => p.id), ['a', 'b', 'c']);
    assert.equal(model.past.length, history); assert.equal(model.future.length, future);
  }
});

// Render exported PDFs to pixels: validates the complete overlay-to-PDF transform,
// including rotated pages, non-zero CropBox origins, and non-default UserUnit.
test('marker opacity blends once per stroke and opaque legacy strokes still render', () => {
  const canvas = createCanvas(100, 100);
  const ctx = canvas.getContext('2d');
  const viewport = { scale: 1, convertToViewportPoint: (x, y) => [x, y] };
  const marker = { tool: 'pen', color: '#ff0000', width: 12, opacity: 0.25, points: [[20, 20], [80, 20], [20, 20]] };
  const alpha = (x, y) => ctx.getImageData(x, y, 1, 1).data[3];
  paintOverlay(ctx, { strokes: [marker] }, viewport);
  const firstAlpha = alpha(50, 20);
  assert.ok(Math.abs(firstAlpha - 64) <= 1, 'Self-overlap must not darken the same stroke');
  paintOverlay(ctx, { strokes: [marker, marker] }, viewport);
  assert.ok(Math.abs(alpha(50, 20) - (firstAlpha + firstAlpha * (1 - firstAlpha / 255))) <= 1,
    'Separate marker strokes should blend with 8-bit alpha rounding');
  paintOverlay(ctx, { strokes: [marker, { color: '#0000ff', width: 8, points: [[50, 60]] }] }, viewport);
  assert.equal(alpha(50, 60), 255);
  assert.equal(ctx.globalAlpha, 1);
});

test('line ignores intermediate drag points; ellipse has an unfilled interior in either drag direction', () => {
  const canvas = createCanvas(100, 100);
  const ctx = canvas.getContext('2d');
  const viewport = { scale: 1, convertToViewportPoint: (x, y) => [x, y] };
  const alpha = (x, y) => ctx.getImageData(x, y, 1, 1).data[3];
  paintOverlay(ctx, { strokes: [{ tool: 'line', color: '#ff0000', width: 4, opacity: 0.5, points: [[20, 20], [50, 80], [80, 20]] }] }, viewport);
  assert.ok(Math.abs(alpha(50, 20) - 128) <= 1);
  assert.equal(alpha(50, 80), 0);
  for (const points of [[[20, 30], [80, 70]], [[80, 70], [20, 30]]]) {
    paintOverlay(ctx, { strokes: [{ tool: 'ellipse', color: '#ff0000', width: 4, points }] }, viewport);
    assert.equal(alpha(50, 50), 0);
    for (const [x, y] of [[50, 30], [50, 70], [20, 50], [80, 50]]) assert.ok(alpha(x, y) > 240);
  }
  assert.doesNotThrow(() => paintOverlay(ctx, { strokes: [{ tool: 'ellipse', color: '#ff0000', width: 4, points: [[20, 20], [80, 20]] }] }, viewport));
});

test('rectangle stays unfilled, honors opacity, and supports reverse or degenerate drags', () => {
  const canvas = createCanvas(100, 100); const ctx = canvas.getContext('2d');
  const viewport = { scale: 1, convertToViewportPoint: (x, y) => [x, y] };
  const alpha = (x, y) => ctx.getImageData(x, y, 1, 1).data[3];
  for (const points of [[[20, 30], [80, 70]], [[80, 70], [20, 30]]]) {
    paintOverlay(ctx, { strokes: [{ tool: 'rectangle', color: '#ff0000', width: 4, opacity: 0.5, points }] }, viewport);
    assert.equal(alpha(50, 50), 0);
    for (const [x, y] of [[50, 30], [50, 70], [20, 50], [80, 50]]) assert.ok(Math.abs(alpha(x, y) - 128) <= 1);
  }
  paintOverlay(ctx, { strokes: [{ tool: 'rectangle', color: '#ff0000', width: 4, points: [[20, 20], [80, 20]] }] }, viewport);
  assert.equal(alpha(50, 20), 255);
});

test('text drag clamps to paper at every rotation, remains immutable, and undo/redo restore its position', async () => {
  const ctx = createCanvas(200, 300).getContext('2d');
  const document = await PDFDocument.create();
  document.addPage([240, 360]).setCropBox(20, 30, 200, 300);
  const preview = await pdfjs.getDocument({ data: await document.save() }).promise;
  const page = await preview.getPage(1);
  for (const rotation of [0, 90, 180, 270]) {
    const viewport = page.getViewport({ scale: 1, rotation });
    const annotation = { id: 'text', tool: 'text', text: 'First\nSecond', color: '#123456', fontSize: 14,
      rotation: 0, points: [[80, 200]] };
    const original = structuredClone(annotation);
    for (const [dx, dy] of [[1000, 1000], [-1000, -1000]]) {
      const moved = moveText(ctx, annotation, viewport, dx, dy);
      const bounds = textLayout(ctx, moved, viewport);
      assert.ok(bounds.left >= -1e-8 && bounds.top >= -1e-8);
      assert.ok(bounds.right <= viewport.width + 1e-8 && bounds.bottom <= viewport.height + 1e-8);
      assert.equal(bounds.lines.length, 2);
      assert.deepEqual(annotation, original);
      const model = new EditorModel();
      model.commit([{ id: 'page', strokes: [annotation] }], { activeId: 'page' });
      model.update(new Set(['page']), p => ({ ...p, strokes: [moved] }));
      model.undo(); assert.deepEqual(model.active.strokes[0].points, annotation.points);
      model.redo(); assert.deepEqual(model.active.strokes[0].points, moved.points);
    }
  }
  await preview.loadingTask.destroy();
});

test('text keyboard steps follow screen directions at every rotation and zoom', async () => {
  const ctx = createCanvas(200, 300).getContext('2d');
  const document = await PDFDocument.create();
  document.addPage([240, 360]).setCropBox(20, 30, 200, 300);
  const preview = await pdfjs.getDocument({ data: await document.save() }).promise;
  try {
    const page = await preview.getPage(1);
    for (const rotation of [0, 90, 180, 270]) for (const scale of [0.5, 1, 2]) {
      const viewport = page.getViewport({ scale, rotation });
      const annotation = { id: 'text', tool: 'text', text: 'Note', color: '#222222', fontSize: 12,
        rotation: 0, points: [viewport.convertToPdfPoint(viewport.width / 2, viewport.height / 2)] };
      const before = textLayout(ctx, annotation, viewport);
      for (const step of [1, 10]) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const moved = moveText(ctx, annotation, viewport, dx * step * scale, dy * step * scale);
        const after = textLayout(ctx, moved, viewport);
        assert.ok(Math.abs(after.x - before.x - dx * step * scale) < 1e-8);
        assert.ok(Math.abs(after.y - before.y - dy * step * scale) < 1e-8);
      }
      const edge = moveText(ctx, annotation, viewport, -1e6, 0);
      const blocked = moveText(ctx, edge, viewport, -scale, 0);
      assert.ok(Math.hypot(blocked.points[0][0] - edge.points[0][0], blocked.points[0][1] - edge.points[0][1]) < 1e-8);
    }
  } finally { await preview.loadingTask.destroy(); }
});

test('stroke movement preserves all points/styles and follows screen directions at every rotation and zoom', async () => {
  const document = await PDFDocument.create();
  document.addPage([240, 360]).setCropBox(20, 30, 200, 300);
  const preview = await pdfjs.getDocument({ data: await document.save() }).promise;
  try {
    const page = await preview.getPage(1);
    for (const rotation of [0, 90, 180, 270]) for (const scale of [0.5, 1, 2]) {
      const viewport = page.getViewport({ scale, rotation });
      for (const tool of [undefined, 'pen', 'line', 'ellipse', 'rectangle']) {
        const annotation = { id: 'stroke', tool, color: '#ff0000', width: 8, opacity: 0.3,
          points: [[80, 150], [100, 180], [140, 200]] };
        const original = structuredClone(annotation);
        const before = strokeLayout(annotation, viewport);
        for (const step of [1, 10]) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const moved = moveStroke(annotation, viewport, dx * step * scale, dy * step * scale);
          const after = strokeLayout(moved, viewport);
          assert.ok(Math.abs(after.left - before.left - dx * step * scale) < 1e-8);
          assert.ok(Math.abs(after.top - before.top - dy * step * scale) < 1e-8);
          assert.deepEqual({ ...moved, points: annotation.points }, annotation);
          for (let i = 1; i < moved.points.length; i++) for (const axis of [0, 1]) {
            assert.ok(Math.abs(moved.points[i][axis] - moved.points[0][axis]
              - (annotation.points[i][axis] - annotation.points[0][axis])) < 1e-8);
          }
        }
        for (const [dx, dy] of [[1e6, 1e6], [-1e6, -1e6]]) {
          const moved = moveStroke(annotation, viewport, dx, dy);
          const bounds = strokeLayout(moved, viewport);
          assert.ok(bounds.left >= -1e-8 && bounds.top >= -1e-8);
          assert.ok(bounds.right <= viewport.width + 1e-8 && bounds.bottom <= viewport.height + 1e-8);
          const blocked = moveStroke(moved, viewport, dx, dy);
          for (let i = 0; i < moved.points.length; i++) {
            assert.ok(Math.hypot(blocked.points[i][0] - moved.points[i][0], blocked.points[i][1] - moved.points[i][1]) < 1e-8);
          }
          const model = new EditorModel();
          model.commit([{ id: 'page', strokes: [annotation] }]);
          model.update(new Set(['page']), p => ({ ...p, strokes: [moved] }));
          model.undo(); assert.deepEqual(model.active.strokes[0], annotation);
          model.redo(); assert.deepEqual(model.active.strokes[0], moved);
          model.update(new Set(['page']), p => ({ ...p, strokes: [] }));
          model.undo(); assert.deepEqual(model.active.strokes[0], moved);
          model.redo(); assert.deepEqual(model.active.strokes, []);
        }
        assert.deepEqual(annotation, original);
      }
    }
  } finally { await preview.loadingTask.destroy(); }
});

test('stroke bounds include line width, dots and the rendered shape endpoints', () => {
  const viewport = { scale: 2, width: 200, height: 200,
    convertToViewportPoint: (x, y) => [x * 2, y * 2], convertToPdfPoint: (x, y) => [x / 2, y / 2] };
  const dot = { width: 10, points: [[50, 50]] };
  assert.deepEqual(strokeLayout(dot, viewport), { x: 90, y: 90, left: 90, right: 110, top: 90, bottom: 110, width: 20, height: 20, angle: 0 });
  assert.deepEqual(moveStroke(dot, viewport, -1e6, -1e6).points, [[5, 5]]);
  const points = [[20, 30], [500, 500], [80, 70]];
  for (const tool of ['line', 'ellipse', 'rectangle']) {
    const bounds = strokeLayout({ tool, width: 4, points }, viewport);
    assert.equal(bounds.right, 164); assert.equal(bounds.bottom, 144);
  }
});

for (const rotation of [0, 90, 180, 270]) for (const userUnit of [1, 2]) {
  test(`export overlay visually matches preview: rotation ${rotation}, UserUnit ${userUnit}`, async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([240, 320]);
    page.setCropBox(20, 30, 180, 250);
    page.setRotation(degrees(rotation));
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(userUnit));
    page.drawRectangle({ x: 20, y: 30, width: 180, height: 250, color: rgb(1, 1, 1) });
    const preview = await pdfjs.getDocument({ data: await document.save(), useSystemFonts: true }).promise;
    const source = { document, preview };
    const record = { sourceId: 'a', index: 0, rotation,
      strokes: [{ color: '#ef2030', width: 8, points: [[45, 70], [110, 130], [155, 220]] }, { color: '#2030ef', width: 9, points: [[80, 240]] },
        { tool: 'pen', color: '#f3cf20', width: 30, opacity: 0.25, points: [[35, 90], [160, 90]] },
        { tool: 'line', color: '#208040', width: 4, opacity: 0.6, points: [[40, 150], [175, 200]] },
        { tool: 'ellipse', color: '#8030c0', width: 5, opacity: 0.7, points: [[70, 110], [170, 210]] },
        { tool: 'rectangle', color: '#1680c0', width: 3, opacity: 0.5, points: [[60, 90], [160, 190]] },
        { tool: 'text', id: 'text', text: 'Note\nPDF', fontSize: 12, rotation: 0, color: '#222222', points: [[60, 240]] },
        { tool: 'text', id: 'rotated-text', text: 'At 90', fontSize: 10, rotation: 90, color: '#108030', points: [[110, 160]] }],
      watermark: { text: 'DRAFT', color: '#7060aa', opacity: 0.35 } };
    const pdfPage = await preview.getPage(1);
    const viewport = pdfPage.getViewport({ scale: 1, rotation });
    record.strokes[0] = moveStroke(record.strokes[0], viewport, 7, -9);
    record.strokes[2] = moveStroke(record.strokes[2], viewport, -4, 6);
    record.watermark = moveWatermark(createCanvas(1, 1).getContext('2d'), record.watermark, viewport, 12, -15);
    const expected = createCanvas(viewport.width, viewport.height);
    const overlay = createCanvas(viewport.width, viewport.height);
    paintOverlay(overlay.getContext('2d'), record, viewport);
    const context = expected.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, expected.width, expected.height); context.drawImage(overlay, 0, 0);
    const bytes = await buildPdf([record], new Map([['a', source]]), async () => ({ bytes: new Uint8Array(overlay.toBuffer('image/png')), placement: imagePlacement(viewport) }));
    const exported = await pdfjs.getDocument({ data: bytes }).promise;
    const actualPage = await exported.getPage(1);
    const actualView = actualPage.getViewport({ scale: 1 });
    assert.equal(actualView.width, viewport.width); assert.equal(actualView.height, viewport.height);
    const actual = createCanvas(actualView.width, actualView.height);
    await actualPage.render({ canvasContext: actual.getContext('2d'), viewport: actualView }).promise;
    const expectedPixels = context.getImageData(0, 0, expected.width, expected.height).data;
    const actualPixels = actual.getContext('2d').getImageData(0, 0, actual.width, actual.height).data;
    let error = 0;
    for (let i = 0; i < expectedPixels.length; i++) error += Math.abs(expectedPixels[i] - actualPixels[i]);
    assert.ok(error / expectedPixels.length < 0.8, `Mean pixel error: ${error / expectedPixels.length}`);
    await preview.loadingTask.destroy(); await exported.loadingTask.destroy();
  });
}

test('manifest uses only sidePanel permission and a local worker entry', async () => {
  const manifest = JSON.parse(await readFile('public/manifest.json', 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['sidePanel']);
  assert.equal(manifest.host_permissions, undefined);
  assert.ok(!manifest.content_security_policy.extension_pages.includes('unsafe-eval'));
  assert.equal(manifest.side_panel.default_path, 'index.html');
});
