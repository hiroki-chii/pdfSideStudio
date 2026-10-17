import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { paintOverlay } from '../src/pdf.js';
import { createFullscreenPreview } from '../src/fullscreen-preview.js';

async function setup(pageCount = 1) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  page.drawRectangle({ x: 20, y: 20, width: 40, height: 40, color: rgb(1, 0, 0) });
  for (let index = 1; index < pageCount; index++) doc.addPage([800, 600]);
  const preview = await pdfjs.getDocument({ data: await doc.save() }).promise;
  const nodes = new Map(), paints = [], events = [];
  let resize;
  const node = id => {
    if (!nodes.has(id)) {
      const element = {};
      if (['fullscreen-pdf', 'fullscreen-ink'].includes(id)) {
        const canvas = createCanvas(1, 1);
        // DOM canvases allow zero dimensions; the native test canvas defaults to 350×150.
        for (const key of ['width', 'height']) {
          let value = 1;
          Object.defineProperty(element, key, { get: () => value,
            set(next) { value = next; canvas[key] = Math.max(1, next); } });
        }
        element.getContext = type => canvas.getContext(type);
      }
      Object.assign(element, { style: {}, handlers: {}, options: {}, open: false,
        clientWidth: 300, clientHeight: 700, scrollLeft: 0, scrollTop: 0,
        addEventListener(type, handler, options) { this.handlers[type] = handler; this.options[type] = options; },
        showModal() { this.open = true; }, close() { this.open = false; this.closed = this.handlers.close(); },
        focus() { events.push(`focus:${id}`); },
        getBoundingClientRect() { return { left: 0, top: 0,
          width: parseFloat(this.style.width) || this.clientWidth,
          height: parseFloat(this.style.height) || this.clientHeight }; },
      });
      nodes.set(id, element);
    }
    return nodes.get(id);
  };
  const snapshot = { record: { index: 0, rotation: 0,
    strokes: [{ id: 'ink', tool: 'line', color: '#0000ff', width: 8, opacity: 1, points: [[100, 100], [200, 200]] }],
    watermark: { text: 'DRAFT', opacity: 0.2, color: '#ff0000' } },
  source: { preview }, pageIndex: 0, pageCount, label: `fixture.pdf · 1 / ${pageCount}` };
  const pages = Array.from({ length: pageCount }, (_, index) => index === 0 ? snapshot : {
    ...snapshot, record: { ...snapshot.record, index, rotation: index === 1 ? 90 : 0, strokes: [] },
    pageIndex: index, label: `fixture.pdf · ${index + 1} / ${pageCount}`,
  });
  const state = { snapshot, pages };
  const root = { getElementById: node, documentElement: { style: { overflow: '' }, clientWidth: 305 },
    body: { style: { paddingRight: '' } }, defaultView: { innerWidth: 320, getComputedStyle: () => ({ paddingRight: '0px' }),
      requestAnimationFrame: callback => setImmediate(callback), cancelAnimationFrame: frame => clearImmediate(frame) } };
  root.scrollingElement = { scrollTop: 120, scrollLeft: 0 };
  const controller = createFullscreenPreview({ root, getPreview: index => index === undefined ? state.snapshot : state.pages[index],
    pixelRatio: () => 2,
    observe(callback) { resize = callback; return { observe() {} }; },
    paint(context, record, viewport) { paints.push({ record, viewport }); paintOverlay(context, record, viewport); },
  });
  return { root, node, state, snapshot, controller, paints, events, resize: () => resize(),
    cleanup: () => preview.loadingTask.destroy() };
}

test('full panel preview renders PDF, drawings and watermark without changing editor state', async () => {
  const env = await setup();
  try {
    const { controller, node, snapshot, paints } = env;
    const original = JSON.stringify(snapshot.record);
    await controller.open();
    assert.equal(node('fullscreen-preview').open, true);
    assert.equal(node('fullscreen-label').textContent, snapshot.label);
    assert.equal(node('fullscreen-zoom-value').textContent, '100%');
    assert.equal(node('fullscreen-page-position').textContent, '1 / 1');
    assert.equal(node('fullscreen-previous').disabled, true);
    assert.equal(node('fullscreen-next').disabled, true);
    await node('fullscreen-previous').handlers.click();
    await node('fullscreen-next').handlers.click();
    assert.equal(paints.length, 1);
    assert.equal(node('fullscreen-status').hidden, true);
    assert.equal(node('fullscreen-paper').style.visibility, 'visible');
    assert.equal(paints[0].record, snapshot.record);
    assert.equal(node('fullscreen-pdf').width, node('fullscreen-ink').width);
    assert.equal(node('fullscreen-pdf').height, node('fullscreen-ink').height);
    assert.ok(node('fullscreen-ink').getContext('2d').getImageData(0, 0, node('fullscreen-ink').width, node('fullscreen-ink').height).data.some(value => value));
    assert.equal(JSON.stringify(snapshot.record), original);
  } finally { await env.cleanup(); }
});

test('close button and Escape close the temporary preview, release canvases and restore opener focus', async () => {
  const env = await setup();
  try {
    const { controller, node, events } = env;
    const dialog = node('fullscreen-preview');
    await controller.open();
    assert.equal(env.root.documentElement.style.overflow, 'hidden');
    assert.equal(env.root.body.style.paddingRight, 'calc(0px + 15px)');
    env.root.scrollingElement.scrollTop = 0;
    node('fullscreen-close').handlers.click(); await dialog.closed;
    assert.equal(dialog.open, false);
    assert.equal(env.root.documentElement.style.overflow, '');
    assert.equal(env.root.body.style.paddingRight, '');
    assert.equal(env.root.scrollingElement.scrollTop, 120);
    assert.equal(node('fullscreen-pdf').width, 0);
    assert.equal(events.at(-1), 'focus:open-fullscreen-preview');
    await controller.open();
    let prevented = false;
    dialog.handlers.cancel({ preventDefault() { prevented = true; } }); await dialog.closed;
    assert.equal(prevented, true);
    assert.equal(dialog.open, false);
    assert.equal(node('fullscreen-ink').height, 0);
    assert.equal(events.at(-1), 'focus:open-fullscreen-preview');
  } finally { await env.cleanup(); }
});

test('full panel zoom respects limits and reopens at fit size; unavailable pages do not open', async () => {
  const env = await setup();
  try {
    const { controller, node, state } = env;
    state.snapshot = null; await controller.open();
    assert.equal(node('fullscreen-preview').open, false);
    state.snapshot = env.snapshot; await controller.open();
    const fitWidth = node('fullscreen-pdf').width;
    for (let i = 0; i < 12; i++) await node('fullscreen-zoom-in').handlers.click();
    assert.equal(node('fullscreen-zoom-value').textContent, '400%');
    assert.equal(node('fullscreen-zoom-in').disabled, true);
    assert.ok(node('fullscreen-pdf').width >= fitWidth * 4 - 1);
    for (let i = 0; i < 14; i++) await node('fullscreen-zoom-out').handlers.click();
    assert.equal(node('fullscreen-zoom-value').textContent, '50%');
    assert.equal(node('fullscreen-zoom-out').disabled, true);
    await node('fullscreen-zoom-fit').handlers.click();
    assert.equal(node('fullscreen-pdf').width, fitWidth);
    await node('fullscreen-zoom-in').handlers.click();
    node('fullscreen-close').handlers.click(); await node('fullscreen-preview').closed;
    await controller.open();
    assert.equal(node('fullscreen-zoom-value').textContent, '100%');
    assert.equal(node('fullscreen-pdf').width, fitWidth);
  } finally { await env.cleanup(); }
});

test('closing while loading prevents late rendering from reviving a closed dialog', async () => {
  const env = await setup();
  try {
    let resolvePage;
    const pagePromise = new Promise(resolve => { resolvePage = resolve; });
    env.state.snapshot = { ...env.snapshot, source: { preview: { getPage: () => pagePromise } } };
    const opening = env.controller.open();
    env.node('fullscreen-close').handlers.click(); await env.node('fullscreen-preview').closed;
    resolvePage({ getViewport() { throw new Error('Closed preview must not render'); } });
    await opening;
    assert.equal(env.node('fullscreen-preview').open, false);
    assert.equal(env.node('fullscreen-pdf').width, 0);
    assert.equal(env.paints.length, 0);
  } finally { await env.cleanup(); }
});

test('render failures keep the close control available and allow retry', async () => {
  const env = await setup();
  try {
    env.state.snapshot = { ...env.snapshot, source: { preview: { getPage: () => Promise.reject(new Error('invalid page')) } } };
    await env.controller.open();
    assert.equal(env.node('fullscreen-preview').open, true);
    assert.equal(env.node('fullscreen-status').hidden, false);
    assert.match(env.node('fullscreen-status').textContent, /表示できません/);
    env.node('fullscreen-close').handlers.click(); await env.node('fullscreen-preview').closed;
    env.state.snapshot = env.snapshot; await env.controller.open();
    assert.equal(env.node('fullscreen-status').hidden, true);
  } finally { await env.cleanup(); }
});

test('resizing and Ctrl+wheel redraw the full panel preview while keeping ordinary scrolling available', async () => {
  const env = await setup();
  try {
    const { controller, node, paints } = env;
    await controller.open();
    const oldWidth = node('fullscreen-pdf').width;
    const scroll = node('fullscreen-scroll');
    scroll.clientWidth = 220; env.resize();
    assert.equal(paints.length, 1, 'ResizeObserver must not redraw synchronously inside its notification');
    for (let i = 0; i < 10 && paints.length < 2; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(paints.length, 2);
    assert.ok(node('fullscreen-pdf').width < oldWidth);
    assert.equal(scroll.options.wheel.passive, false);
    let prevented = false;
    const event = { ctrlKey: false, deltaY: -100, preventDefault() { prevented = true; } };
    scroll.handlers.wheel(event);
    assert.equal(prevented, false);
    assert.equal(node('fullscreen-zoom-value').textContent, '100%');
    event.ctrlKey = true; scroll.handlers.wheel(event);
    for (let i = 0; i < 10 && !node('fullscreen-status').hidden; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(prevented, true);
    assert.equal(node('fullscreen-zoom-value').textContent, '125%');
    assert.equal(node('fullscreen-status').hidden, true);
    const count = paints.length;
    scroll.clientWidth = 200; env.resize();
    node('fullscreen-close').handlers.click(); await node('fullscreen-preview').closed;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(paints.length, count, 'Closing cancels a scheduled resize redraw');
  } finally { await env.cleanup(); }
});

test('pagination moves through edited page order, preserves zoom and leaves the editor on its original page', async () => {
  const env = await setup(3);
  try {
    const { controller, node, state, paints } = env;
    const original = JSON.stringify(state.pages.map(page => page.record));
    await controller.open();
    assert.equal(node('fullscreen-previous').disabled, true);
    assert.equal(node('fullscreen-next').disabled, false);
    await node('fullscreen-zoom-in').handlers.click();
    node('fullscreen-scroll').scrollLeft = 50; node('fullscreen-scroll').scrollTop = 70;
    await node('fullscreen-next').handlers.click();
    assert.equal(node('fullscreen-page-position').textContent, '2 / 3');
    assert.equal(node('fullscreen-label').textContent, state.pages[1].label);
    assert.equal(node('fullscreen-zoom-value').textContent, '125%');
    assert.equal(node('fullscreen-scroll').scrollLeft, 0);
    assert.equal(node('fullscreen-scroll').scrollTop, 0);
    assert.equal(paints.at(-1).record, state.pages[1].record);
    assert.equal(paints.at(-1).viewport.rotation, 90);
    assert.equal(node('fullscreen-previous').disabled, false);
    await node('fullscreen-next').handlers.click();
    assert.equal(node('fullscreen-page-position').textContent, '3 / 3');
    assert.equal(node('fullscreen-next').disabled, true);
    const count = paints.length;
    await node('fullscreen-next').handlers.click(); assert.equal(paints.length, count);
    await node('fullscreen-previous').handlers.click();
    assert.equal(node('fullscreen-page-position').textContent, '2 / 3');
    assert.equal(node('fullscreen-next').disabled, false);
    assert.equal(JSON.stringify(state.pages.map(page => page.record)), original);
    assert.equal(state.snapshot, state.pages[0]);
    node('fullscreen-close').handlers.click(); await node('fullscreen-preview').closed;
    await controller.open();
    assert.equal(node('fullscreen-page-position').textContent, '1 / 3');
  } finally { await env.cleanup(); }
});

test('pagination opens at the active page and arrow shortcuts yield to horizontal scrolling and modified keys', async () => {
  const env = await setup(3);
  try {
    const { controller, node, state, paints } = env;
    state.snapshot = state.pages[1];
    await controller.open();
    assert.equal(node('fullscreen-page-position').textContent, '2 / 3');
    const event = { key: 'ArrowRight', target: node('fullscreen-close'), prevented: false,
      preventDefault() { this.prevented = true; } };
    await node('fullscreen-preview').handlers.keydown(event);
    assert.equal(event.prevented, true);
    assert.equal(node('fullscreen-page-position').textContent, '3 / 3');
    const count = paints.length;
    for (const overrides of [{ ctrlKey: true }, { shiftKey: true }, { altKey: true }, { metaKey: true },
      { isComposing: true }, { defaultPrevented: true }, { key: 'Escape' }]) {
      const ignored = { ...event, key: 'ArrowLeft', prevented: false, ...overrides };
      await node('fullscreen-preview').handlers.keydown(ignored);
      assert.equal(ignored.prevented, false);
      assert.equal(paints.length, count);
    }
    const scroll = node('fullscreen-scroll'); scroll.scrollWidth = scroll.clientWidth + 50;
    const scrolling = { ...event, key: 'ArrowLeft', target: scroll, prevented: false };
    await node('fullscreen-preview').handlers.keydown(scrolling);
    assert.equal(scrolling.prevented, false);
    assert.equal(paints.length, count);
    await node('fullscreen-preview').handlers.keydown({ ...event, key: 'ArrowLeft' });
    assert.equal(node('fullscreen-page-position').textContent, '2 / 3');
    assert.equal(paints.at(-1).record, state.pages[1].record);
  } finally { await env.cleanup(); }
});

test('rapid pagination discards stale page loads and renders each page using its own source', async () => {
  const env = await setup(2);
  try {
    const { controller, node, state, paints } = env;
    await controller.open();
    let resolvePage;
    const pending = new Promise(resolve => { resolvePage = resolve; });
    const second = state.pages[1];
    second.record.index = 0;
    second.source = { preview: { getPage(number) { assert.equal(number, 1); return pending; } } };
    const loading = node('fullscreen-next').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    await node('fullscreen-previous').handlers.click();
    resolvePage({ getViewport() { throw new Error('Stale page must not render'); } });
    await loading;
    assert.equal(node('fullscreen-page-position').textContent, '1 / 2');
    assert.equal(paints.at(-1).record, state.pages[0].record);
    assert.equal(node('fullscreen-status').hidden, true);
    assert.equal(node('fullscreen-paper').style.visibility, 'visible');
  } finally { await env.cleanup(); }
});
