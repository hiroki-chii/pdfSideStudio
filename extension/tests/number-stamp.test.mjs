import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { EditorModel } from '../src/model.js';
import { textLayout, moveText, paintOverlay, buildPdf, imagePlacement } from '../src/pdf.js';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const script = app.slice(app.indexOf('function placeNumberStamp('), app.indexOf("\n$('help').addEventListener"));
const patterns = ['plain', 'circle', 'circle-filled', 'square', 'square-filled'];

async function setup(rotation = 0, scale = 1) {
  const document = await PDFDocument.create(); document.addPage([240, 360]); document.addPage([240, 360]);
  const preview = await pdfjs.getDocument({ data: await document.save() }).promise;
  const viewport = (await preview.getPage(1)).getViewport({ rotation, scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const model = new EditorModel();
  model.commit(['a', 'b'].map((id, index) => ({ id, sourceId: 'source', index, rotation, strokes: [] })));
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', handlers: {},
      addEventListener(type, handler) { this.handlers[type] = handler; },
      getContext: () => canvas.getContext('2d') });
    return nodes.get(id);
  };
  $('stamp-size').value = '24'; $('stamp-color').value = '#e05267'; $('stamp-pattern').value = 'plain';
  let id = 0;
  const errors = [];
  const context = vm.createContext({ $, model, viewport, textLayout, moveText, paintOverlay,
    busy: false, stroke: null, annotationDrag: null, pageDrag: null, renderedPageId: 'a',
    activePreviewMenu: 'stamp', textEnabled: false, penEnabled: false,
    uid: () => `stamp-${++id}`, pdfPoint: event => viewport.convertToPdfPoint(event.clientX, event.clientY),
    refreshThumbnails() {}, refreshAnnotationHandles() {}, status() {}, updateControls() {},
    fail: error => errors.push(error.message) });
  vm.runInContext(script, context);
  const click = (x = 80, y = 100, overrides = {}) => $('ink-canvas').handlers.pointerdown({
    button: 0, isPrimary: true, clientX: x, clientY: y, preventDefault() {}, ...overrides });
  return { $, model, context, click, errors, viewport, canvas, preview, document };
}

test('each stamp click places one number, continues across pages, and restores numbering with undo/redo', async t => {
  const { model, context, click, preview } = await setup();
  t.after(() => preview.loadingTask.destroy());
  click(); click(120, 150);
  assert.deepEqual(Array.from(model.active.strokes, s => s.text), ['1', '2']);
  assert.equal(model.nextStampNumber, 3);
  model.activeId = 'b'; context.renderedPageId = 'b'; click();
  assert.equal(model.active.strokes[0].text, '3');
  model.undo(); assert.equal(model.active.strokes.length, 0); assert.equal(model.nextStampNumber, 3);
  model.redo(); assert.equal(model.active.strokes[0].text, '3'); assert.equal(model.nextStampNumber, 4);
  model.undo(); click();
  assert.equal(model.active.strokes[0].text, '3'); assert.equal(model.future.length, 0);
  // Removing a placed number must not renumber the others or reuse it automatically.
  model.update(new Set(['b']), page => ({ ...page, strokes: [] }));
  assert.equal(model.nextStampNumber, 4);
});

test('custom starting numbers and settings work; invalid input and blocked gestures consume no numbers', async t => {
  const { $, model, context, click, errors, preview } = await setup();
  t.after(() => preview.loadingTask.destroy());
  $('stamp-number').value = '9'; $('stamp-number').handlers.change();
  $('stamp-size').value = '36'; $('stamp-color').value = '#123456';
  click(); click();
  assert.deepEqual(Array.from(model.active.strokes, s => s.text), ['9', '10']);
  assert.equal(model.active.strokes[0].fontSize, 36);
  assert.equal(model.active.strokes[0].color, '#123456');
  const history = model.past.length;
  for (const invalid of ['', '0', '-1', '1.5', 'abc', '9007199254740991']) {
    $('stamp-number').value = invalid; $('stamp-number').handlers.change();
    assert.equal(model.nextStampNumber, 11);
  }
  for (const invalid of ['', '0', '7', '97', 'abc']) { $('stamp-size').value = invalid; click(); }
  $('stamp-size').value = '24';
  click(80, 100, { button: 2 }); click(80, 100, { isPrimary: false });
  for (const guard of ['busy', 'stroke', 'annotationDrag', 'pageDrag']) {
    context[guard] = true; click(); context[guard] = null;
  }
  context.renderedPageId = 'b'; click();
  assert.equal(model.past.length, history);
  assert.equal(model.nextStampNumber, 11);
  assert.equal(errors.length, 11);
});

test('stamp placement centers the number and stays on paper at every rotation and zoom', async t => {
  for (const rotation of [0, 90, 180, 270]) for (const scale of [0.5, 2]) {
    const { $, model, click, viewport, canvas, preview } = await setup(rotation, scale);
    t.after(() => preview.loadingTask.destroy());
    for (const pattern of patterns) {
      $('stamp-pattern').value = pattern;
      click(viewport.width / 2, viewport.height / 2);
      const centered = textLayout(canvas.getContext('2d'), model.active.strokes.at(-1), viewport);
      assert.ok(Math.abs(centered.x + centered.width / 2 - viewport.width / 2) < 1e-8);
      assert.ok(Math.abs(centered.y + centered.height / 2 - viewport.height / 2) < 1e-8);
      for (const [x, y] of [[0, 0], [viewport.width, viewport.height]]) {
        click(x, y);
        const bounds = textLayout(canvas.getContext('2d'), model.active.strokes.at(-1), viewport);
        assert.ok(bounds.left >= -1e-8 && bounds.top >= -1e-8);
        assert.ok(bounds.right <= viewport.width + 1e-8 && bounds.bottom <= viewport.height + 1e-8);
      }
      assert.ok(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((v, i) => i % 4 === 3 && v > 0));
    }
  }
});

test('pattern changes keep the sequence and previously placed shapes; undo/redo and movement retain the pattern', async t => {
  const { $, model, click, viewport, canvas, preview } = await setup();
  t.after(() => preview.loadingTask.destroy());
  for (const pattern of patterns) { $('stamp-pattern').value = pattern; click(); }
  assert.deepEqual(Array.from(model.active.strokes, s => s.stampPattern), patterns);
  assert.deepEqual(Array.from(model.active.strokes, s => s.text), ['1', '2', '3', '4', '5']);
  model.undo(); assert.equal(model.active.strokes.at(-1).stampPattern, 'square'); assert.equal(model.nextStampNumber, 5);
  model.redo(); assert.equal(model.active.strokes.at(-1).stampPattern, 'square-filled'); assert.equal(model.nextStampNumber, 6);
  const annotation = model.active.strokes.at(-1);
  const moved = moveText(canvas.getContext('2d'), annotation, viewport, 20, 30);
  assert.equal(moved.stampPattern, annotation.stampPattern);
  assert.equal(moved.text, annotation.text);
  // Multi-digit labels enlarge the frame instead of overlapping its edge.
  const ctx = canvas.getContext('2d');
  const one = textLayout(ctx, annotation, viewport);
  const many = textLayout(ctx, { ...annotation, text: '123456' }, viewport);
  assert.ok(many.width > one.width);
  assert.equal(many.width, many.height);
  for (const run of many.lineRuns.flat()) {
    assert.ok(run.x > 0 && run.y > 0 && run.x + run.width < many.width);
  }
});

test('circle and square outlines remain hollow, fills have contrasting text and all edges stay in their bounds', async t => {
  const { $, model, click, viewport, canvas, preview } = await setup();
  t.after(() => preview.loadingTask.destroy());
  const ctx = canvas.getContext('2d');
  for (const pattern of patterns.slice(1)) {
    $('stamp-pattern').value = pattern; click(100, 120);
    const annotation = model.active.strokes.at(-1), layout = textLayout(ctx, annotation, viewport);
    const colorAt = (x, y) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data];
    paintOverlay(ctx, { strokes: [annotation] }, viewport, { hideTextFor: annotation.id });
    const interior = colorAt(layout.x + layout.width / 2, layout.y + 4);
    assert.equal(interior[3], pattern.endsWith('-filled') ? 255 : 0, pattern);
    const corner = colorAt(layout.x + 4, layout.y + 4);
    assert.equal(corner[3], pattern === 'square-filled' ? 255 : 0, pattern);
    assert.equal(colorAt(layout.x - 2, layout.y + layout.height / 2)[3], 0);
    assert.equal(colorAt(layout.right + 2, layout.y + layout.height / 2)[3], 0);
    if (layout.stamp.filled) {
      assert.equal(layout.stamp.textColor, '#ffffff');
      paintOverlay(ctx, { strokes: [annotation] }, viewport);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let whites = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 245 && pixels[i + 1] > 245 && pixels[i + 2] > 245 && pixels[i + 3] === 255) whites++;
      assert.ok(whites > 8, 'filled shapes contain visible white digits');
      const light = { ...annotation, color: '#ffffcc' };
      assert.equal(textLayout(ctx, light, viewport).stamp.textColor, '#000000');
    }
  }
});

test('visible digits are centered inside every stamp frame across sizes, zoom and rotation', async t => {
  for (const scale of [1, 2]) {
    const { $, model, click, viewport, canvas, preview } = await setup(0, scale);
    t.after(() => preview.loadingTask.destroy());
    const ctx = canvas.getContext('2d'), frame = createCanvas(canvas.width, canvas.height), frameCtx = frame.getContext('2d');
    for (const pattern of patterns.slice(1)) for (const text of ['1', '12', '908'])
      for (const fontSize of [12, 36]) for (const rotation of [0, 270]) {
        $('stamp-pattern').value = pattern; click();
        const annotation = { ...model.active.strokes.at(-1), text, fontSize, rotation,
          points: [viewport.convertToPdfPoint(100 * scale, 160 * scale)] };
        const layout = textLayout(ctx, annotation, viewport);
        paintOverlay(ctx, { strokes: [annotation] }, viewport);
        paintOverlay(frameCtx, { strokes: [annotation] }, viewport, { hideTextFor: annotation.id });
        const actual = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const background = frameCtx.getImageData(0, 0, canvas.width, canvas.height).data;
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        for (let y = Math.max(0, Math.floor(layout.top)); y < Math.min(canvas.height, Math.ceil(layout.bottom)); y++)
          for (let x = Math.max(0, Math.floor(layout.left)); x < Math.min(canvas.width, Math.ceil(layout.right)); x++) {
            const i = (y * canvas.width + x) * 4;
            if (Math.max(...[0, 1, 2, 3].map(channel => Math.abs(actual[i + channel] - background[i + channel]))) < 48) continue;
            left = Math.min(left, x); right = Math.max(right, x + 1);
            top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
          }
        const label = `${pattern}, ${text}, ${fontSize}pt, zoom ${scale}, rotation ${rotation}`;
        assert.ok(Number.isFinite(left), `visible digits: ${label}`);
        assert.ok(Math.abs((top + bottom - layout.top - layout.bottom) / 2) <= 1, `vertical center: ${label}`);
        assert.ok(Math.abs((left + right - layout.left - layout.right) / 2) <= 1, `horizontal center: ${label}`);
      }
  }
});

test('every pattern matches the saved PDF, including rotation and fill', async t => {
  const { $, model, click, document, viewport, canvas, preview } = await setup(90);
  t.after(() => preview.loadingTask.destroy());
  for (const pattern of patterns) {
    $('stamp-pattern').value = pattern; click(120, 100);
    const record = { ...model.active, strokes: [model.active.strokes.at(-1)] };
    const bytes = await buildPdf([record], new Map([['source', { document }]]), async page => {
      paintOverlay(canvas.getContext('2d'), page, viewport);
      return { bytes: canvas.toBuffer('image/png'), placement: imagePlacement(viewport) };
    });
    const exported = await pdfjs.getDocument({ data: bytes }).promise;
    t.after(() => exported.loadingTask.destroy());
    const page = await exported.getPage(1);
    const output = createCanvas(viewport.width, viewport.height);
    await page.render({ canvasContext: output.getContext('2d'), viewport: page.getViewport({ scale: 1 }) }).promise;
    const expected = createCanvas(viewport.width, viewport.height), ctx = expected.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, expected.width, expected.height); ctx.drawImage(canvas, 0, 0);
    const actual = output.getContext('2d').getImageData(0, 0, output.width, output.height).data;
    const reference = ctx.getImageData(0, 0, expected.width, expected.height).data;
    let difference = 0;
    for (let i = 0; i < actual.length; i++) difference += Math.abs(actual[i] - reference[i]);
    assert.ok(difference / actual.length < 0.05, `${pattern} saved appearance matches preview`);
  }
});

test('placed numbers survive PDF export as visible overlays on rotated pages', async t => {
  const { model, click, document, viewport, canvas, preview } = await setup(90);
  t.after(() => preview.loadingTask.destroy());
  click(); click(160, 100);
  const bytes = await buildPdf([model.active], new Map([['source', { document }]]), async record => {
    paintOverlay(canvas.getContext('2d'), record, viewport);
    return { bytes: canvas.toBuffer('image/png'), placement: imagePlacement(viewport) };
  });
  const exported = await pdfjs.getDocument({ data: bytes }).promise;
  t.after(() => exported.loadingTask.destroy());
  const page = await exported.getPage(1);
  assert.equal(page.rotate, 90);
  const output = createCanvas(viewport.width, viewport.height);
  await page.render({ canvasContext: output.getContext('2d'), viewport: page.getViewport({ scale: 1 }) }).promise;
  const data = output.getContext('2d').getImageData(0, 0, output.width, output.height).data;
  const redPixels = (left, right) => {
    let count = 0;
    for (let y = 70; y < 130; y++) for (let x = left; x < right; x++) {
      const i = (y * output.width + x) * 4;
      if (data[i] > data[i + 1] + 40 && data[i] > data[i + 2] + 40) count++;
    }
    return count;
  };
  assert.ok(redPixels(60, 100) > 20, 'first number is present in the saved PDF');
  assert.ok(redPixels(140, 180) > 20, 'second number is present in the saved PDF');
});
