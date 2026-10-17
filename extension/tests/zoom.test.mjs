import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const previewScript = app.slice(app.indexOf('function setPreviewZoom('), app.indexOf('\nasync function addFiles('));

async function setup(width = 220) {
  const doc = await PDFDocument.create();
  doc.addPage([600, 800]); doc.addPage([800, 600]);
  const pdf = await pdfjs.getDocument({ data: await doc.save() }).promise;
  const pages = [0, 1].map(index => ({ id: `page-${index}`, sourceId: 'pdf', index, rotation: 0, strokes: [] }));
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, {
      style: {}, handlers: {}, listenerOptions: {}, scrollLeft: 0, scrollTop: 0, clientWidth: width, clientHeight: 300,
      addEventListener(type, handler, options) { this.handlers[type] = handler; this.listenerOptions[type] = options; },
      querySelectorAll() { return []; }, getContext() { return {}; },
      getBoundingClientRect() { return { left: 0, top: 0, width: parseFloat(this.style.width) || width,
        height: parseFloat(this.style.height) || 300 }; },
    });
    return nodes.get(id);
  };
  const draws = [], paints = [], errors = [];
  const context = vm.createContext({ $, Math, busy: false, stroke: null, annotationDrag: null, pageDrag: null,
    previewZoom: 1, minPreviewZoom: 0.5, maxPreviewZoom: 4, renderedPageId: null,
    viewport: null, renderTask: null, renderVersion: 0, model: { pages, active: pages[0] },
    window: { devicePixelRatio: 2 }, updateControls() {}, refreshAnnotationHandles() {},
    paintTextPreview() { paints.push(context.viewport); }, fail(error) { errors.push(error); },
    sources: new Map([['pdf', { name: 'fixture.pdf', preview: { async getPage(number) {
      const page = await pdf.getPage(number);
      return { getViewport: options => page.getViewport(options), render({ viewport }) {
        draws.push(viewport); return { promise: Promise.resolve(), cancel() {} };
      } };
    } } }]]),
  });
  vm.runInContext(previewScript, context);
  const settle = async () => {
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, []);
  };
  return { context, $, draws, paints, settle, close: () => pdf.loadingTask.destroy() };
}

test('zoom redraws PDF and annotations together, clamps limits and keeps page data unchanged', async () => {
  const env = await setup();
  try {
    const { context, $, draws, paints, settle } = env;
    const original = JSON.stringify(context.model.pages);
    await context.renderPreview();
    const fitWidth = parseFloat($('canvas-stack').style.width);
    const fitHeight = $('preview-scroll').style.height;
    $('zoom-in').handlers.click(); await settle();
    assert.equal(context.previewZoom, 1.25);
    assert.equal(parseFloat($('canvas-stack').style.width), fitWidth * 1.25);
    assert.equal($('preview-scroll').style.height, fitHeight);
    assert.equal(draws.at(-1), paints.at(-1));
    assert.equal($('pdf-canvas').width, $('ink-canvas').width);
    assert.equal($('pdf-canvas').height, $('ink-canvas').height);
    context.setPreviewZoom(100); await settle(); assert.equal(context.previewZoom, 4);
    context.setPreviewZoom(-1); await settle(); assert.equal(context.previewZoom, 0.5);
    $('zoom-fit').handlers.click(); await settle(); assert.equal(context.previewZoom, 1);
    assert.equal(JSON.stringify(context.model.pages), original);
  } finally { await env.close(); }
});

test('zoom is retained across pages, rotation and resizing; changing pages resets scrolling', async () => {
  const env = await setup();
  try {
    const { context, $, settle } = env;
    await context.renderPreview();
    context.setPreviewZoom(2); await settle();
    $('preview-scroll').scrollLeft = 50; $('preview-scroll').scrollTop = 70;
    context.model.active = context.model.pages[1];
    await context.renderPreview();
    assert.equal(context.previewZoom, 2);
    assert.equal($('preview-scroll').scrollLeft, 0);
    assert.equal($('preview-scroll').scrollTop, 0);
    context.model.active.rotation = 90;
    $('preview-scroll').clientWidth = 160;
    await context.renderPreview();
    assert.equal(context.viewport.width / context.viewport.height, 600 / 800);
    assert.equal(parseFloat($('canvas-stack').style.width), (160 - 12) * 2);
    assert.equal(context.previewZoom, 2);
  } finally { await env.close(); }
});

test('zoom is ignored during an active drawing, drag, busy operation or without a page', async () => {
  const env = await setup();
  try {
    const { context } = env;
    for (const key of ['busy', 'stroke', 'annotationDrag', 'pageDrag']) {
      const original = context[key]; context[key] = true;
      context.setPreviewZoom(2); assert.equal(context.previewZoom, 1);
      context[key] = original;
    }
    context.model.active = null;
    context.setPreviewZoom(2); assert.equal(context.previewZoom, 1);
  } finally { await env.close(); }
});

function wheelEvent(overrides = {}) {
  return { ctrlKey: true, deltaY: -100, defaultPrevented: false,
    target: { closest: () => null },
    preventDefault() { this.defaultPrevented = true; }, ...overrides };
}

test('Ctrl+wheel zooms in both directions, cancels browser zoom and respects zoom limits', async () => {
  const env = await setup();
  try {
    const { context, $, settle } = env;
    await context.renderPreview();
    const area = $('preview-area');
    assert.equal(area.listenerOptions.wheel.passive, false);
    const up = wheelEvent(); area.handlers.wheel(up); await settle();
    assert.equal(context.previewZoom, 1.25);
    assert.equal(up.defaultPrevented, true);
    const down = wheelEvent({ deltaY: 100 }); area.handlers.wheel(down); await settle();
    assert.equal(context.previewZoom, 1);
    assert.equal(down.defaultPrevented, true);
    for (const [zoom, deltaY] of [[4, -100], [0.5, 100]]) {
      context.setPreviewZoom(zoom); await settle();
      const event = wheelEvent({ deltaY }); area.handlers.wheel(event); await settle();
      assert.equal(context.previewZoom, zoom);
      assert.equal(event.defaultPrevented, true);
    }
  } finally { await env.close(); }
});

test('ordinary scrolling, tool menus and missing pages keep their default wheel behavior', async () => {
  const env = await setup();
  try {
    const { context, $ } = env;
    for (const overrides of [{ ctrlKey: false }, { deltaY: 0 }, { target: { closest: () => ({}) } }]) {
      const event = wheelEvent(overrides); $('preview-area').handlers.wheel(event);
      assert.equal(context.previewZoom, 1);
      assert.equal(event.defaultPrevented, false);
    }
    context.model.active = null;
    const event = wheelEvent(); $('preview-area').handlers.wheel(event);
    assert.equal(context.previewZoom, 1);
    assert.equal(event.defaultPrevented, false);
  } finally { await env.close(); }
});

test('Ctrl+wheel does not interrupt drawing or busy operations, and still blocks browser zoom', async () => {
  const env = await setup();
  try {
    const { context, $ } = env;
    for (const key of ['busy', 'stroke', 'annotationDrag', 'pageDrag']) {
      const original = context[key]; context[key] = true;
      const event = wheelEvent(); $('preview-area').handlers.wheel(event);
      assert.equal(context.previewZoom, 1);
      assert.equal(event.defaultPrevented, true);
      context[key] = original;
    }
  } finally { await env.close(); }
});
