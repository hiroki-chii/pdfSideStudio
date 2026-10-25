import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { EditorModel, normalizeRotation } from '../src/model.js';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const slice = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));

function setup(tool = 'watermark') {
  const nodes = new Map(), handlers = {}, actions = {}, paints = [];
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', handlers: {},
      addEventListener(type, handler) { this.handlers[type] = handler; },
      dispatchEvent(event) { this.handlers[event.type]?.(event); },
    });
    return nodes.get(id);
  };
  const range = html.match(/<input id="watermark-opacity"[^>]+>/)[0];
  for (const name of ['min', 'max', 'value']) $('watermark-opacity')[name] = range.match(new RegExp(`${name}="([^"]+)"`))[1];
  $('watermark-text').value = 'DRAFT'; $('watermark-color').value = '#736c90';
  $('watermark-scope').value = 'all'; $('rotation-scope').value = 'active';
  const watermark = { text: 'Original', color: '#123456', opacity: 0.3, points: [[20, 30]] };
  const model = new EditorModel();
  model.commit([{ id: 'a', rotation: 0, strokes: [], watermark },
    { id: 'b', rotation: 270, strokes: [], watermark: null }]);
  const context = vm.createContext({ $, model, normalizeRotation, Event,
    document: { addEventListener(type, handler) { handlers[type] = handler; } },
    activePreviewMenu: tool, selectedAnnotationId: null, viewport: {},
    busy: false, stroke: null, annotationDrag: null, pageDrag: null, textEdit: null,
    selectedAnnotation: () => context.selectedAnnotationId === 'watermark' ? { ...model.active.watermark, tool: 'watermark' } : null,
    activeRequired: () => model.active, refresh() {}, status() {}, navigatePage() {}, moveSelectedAnnotation() {},
    paintTextPreview() { paints.push(model.active.watermark.opacity); },
    refreshAnnotationHandles() {}, refreshThumbnails() {}, updateControls() {},
    on(id, action) { actions[id] = action; }, run(action) { action(); },
    handleTextShortcut: () => false, handlePenShortcut: () => false,
  });
  vm.runInContext([
    slice('function rotate(', '\nasync function printPdf()'),
    slice('function watermarkTargets()', "\non('remove-watermark'"),
    slice("$('watermark-opacity').addEventListener('input'", '\n\nfunction selectedText()'),
    slice('function handlePageToolShortcut(', '\nfunction deleteSelectedAnnotation()'),
    slice("document.addEventListener('keydown', event => {", '\nlet resizeTimer;'),
  ].join('\n'), context);
  function key(key, extra = {}) {
    const event = { key, ctrlKey: true, target: { closest: () => null },
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    handlers.keydown(event);
    return event;
  }
  return { $, model, context, actions, key, watermark, paints };
}

test('watermark shortcuts adjust settings by 1%, update the output, and apply to the chosen scope with history', () => {
  const { $, model, key, actions, watermark } = setup();
  const history = model.past.length;
  const event = key('ArrowRight');
  assert.equal(event.defaultPrevented && event.stopped, true);
  assert.equal(Number($('watermark-opacity').value), 21);
  assert.equal($('watermark-opacity-value').value, '21%');
  key('ArrowRight', { repeat: true }); key('ArrowLeft');
  assert.equal(Number($('watermark-opacity').value), 21);
  assert.equal(model.active.watermark, watermark);
  assert.equal(model.past.length, history);
  actions['apply-watermark']();
  assert.ok(model.pages.every(page => page.watermark.opacity === 0.21));
  assert.deepEqual(model.active.watermark.points, watermark.points);
  model.undo(); assert.equal(model.active.watermark, watermark); assert.equal(model.pages[1].watermark, null);
  model.redo(); assert.equal(model.active.watermark.opacity, 0.21);
  $('watermark-scope').value = 'active'; key('ArrowLeft'); actions['apply-watermark']();
  assert.equal(model.active.watermark.opacity, 0.2); assert.equal(model.pages[1].watermark.opacity, 0.21);
});

test('selected watermark shortcuts immediately update only the selected object, preserve selection and support undo/redo', () => {
  const { $, context, model, key, watermark, paints } = setup('select');
  context.selectedAnnotationId = 'watermark';
  context.previewMenuOpen = false;
  const otherPage = { ...model.pages[1], watermark: { ...watermark, opacity: 0.6 } };
  const stroke = { id: 'text', tool: 'text', text: 'Keep' };
  model.commit([{ ...model.active, strokes: [stroke] }, otherPage]);
  const history = model.past.length;
  // Pending menu settings must not overwrite the selected object's properties.
  $('watermark-opacity').value = 65;
  const event = key('ArrowRight');
  assert.equal(event.defaultPrevented && event.stopped, true);
  assert.equal(model.active.watermark.opacity, 0.31);
  assert.equal(Number($('watermark-opacity').value), 31);
  assert.equal($('watermark-opacity-value').value, '31%');
  assert.deepEqual({ ...model.active.watermark, opacity: watermark.opacity }, watermark);
  assert.equal(model.active.strokes[0], stroke); assert.equal(model.pages[1], otherPage);
  assert.equal(context.selectedAnnotationId, 'watermark'); assert.equal(context.previewMenuOpen, false);
  assert.equal(model.past.length, history + 1); assert.deepEqual(paints, [0.31]);
  key('ArrowRight', { repeat: true }); assert.equal(model.active.watermark.opacity, 0.32);
  model.undo(); assert.equal(model.active.watermark.opacity, 0.31);
  model.undo(); assert.equal(model.active.watermark, watermark);
  model.redo(); assert.equal(model.active.watermark.opacity, 0.31);
  key('ArrowLeft'); assert.equal(model.active.watermark.opacity, 0.3);
  assert.equal(model.pages[1], otherPage);
});

test('selected watermark shortcuts clamp limits without creating history or clearing redo, including focused controls', () => {
  const { $, context, model, key, paints } = setup('select');
  context.selectedAnnotationId = 'watermark';
  const sliderTarget = { closest: () => $('watermark-opacity') };
  for (const [value, direction, expected] of [[5, 'ArrowLeft', 5], [70, 'ArrowRight', 70],
    [5, 'ArrowRight', 6], [70, 'ArrowLeft', 69]]) {
    model.update(new Set([model.activeId]), page => ({ ...page, watermark: { ...page.watermark, opacity: value / 100 } }));
    model.commit(model.pages); model.undo();
    const history = model.past.length, redo = model.future.length, paintCount = paints.length;
    const event = key(direction, { target: sliderTarget });
    assert.equal(event.defaultPrevented && event.stopped, true);
    assert.equal(model.active.watermark.opacity, expected / 100);
    assert.equal(Number($('watermark-opacity').value), expected);
    assert.equal($('watermark-opacity-value').value, `${expected}%`);
    assert.equal(model.past.length, history + Number(value !== expected));
    assert.equal(model.future.length, value === expected ? redo : 0);
    assert.equal(paints.length, paintCount + Number(value !== expected));
  }
  key('ArrowLeft', { ctrlKey: false, metaKey: true });
  assert.equal(Number($('watermark-opacity').value), 68);
  key('ArrowLeft', { target: { closest: () => $('watermark-scope') } });
  assert.equal(Number($('watermark-opacity').value), 67);
});

test('rotation shortcuts rotate 90 degrees, normalize angles, respect page scope and support undo/redo', () => {
  const { $, model, key } = setup('rotation');
  const event = key('ArrowLeft');
  assert.equal(event.defaultPrevented && event.stopped, true);
  assert.deepEqual(model.pages.map(page => page.rotation), [270, 270]);
  key('ArrowRight');
  assert.deepEqual(model.pages.map(page => page.rotation), [0, 270]);
  $('rotation-scope').value = 'all';
  key('ArrowRight', { repeat: true, target: { closest: () => $('rotation-scope') } });
  assert.deepEqual(model.pages.map(page => page.rotation), [90, 0]);
  model.undo(); assert.deepEqual(model.pages.map(page => page.rotation), [0, 270]);
  model.redo(); assert.deepEqual(model.pages.map(page => page.rotation), [90, 0]);
  key('ArrowLeft'); assert.deepEqual(model.pages.map(page => page.rotation), [0, 270]);
});

test('page tool shortcuts leave typing, other tools, dialogs, IME and ongoing operations unchanged', () => {
  const guardedSetup = tool => {
    const env = setup(tool === 'selected-watermark' ? 'select' : tool);
    if (tool === 'selected-watermark') env.context.selectedAnnotationId = 'watermark';
    return env;
  };
  for (const tool of ['watermark', 'rotation', 'selected-watermark']) {
    for (const extra of [{ ctrlKey: false }, { altKey: true }, { shiftKey: true }, { defaultPrevented: true },
      { isComposing: true }, { keyCode: 229 }, { target: { closest: () => ({}) } }]) {
      const { $, model, key } = guardedSetup(tool);
      const pages = model.pages, history = model.past.length;
      key('ArrowRight', extra);
      assert.equal(Number($('watermark-opacity').value), 20);
      assert.equal(model.pages, pages); assert.equal(model.past.length, history);
    }
    for (const field of ['busy', 'stroke', 'annotationDrag', 'pageDrag', 'textEdit', 'viewport']) {
      const { $, model, context, key } = guardedSetup(tool);
      context[field] = field === 'viewport' ? null : true;
      const pages = model.pages;
      const event = key('ArrowRight');
      assert.equal(event.defaultPrevented, undefined);
      assert.equal(Number($('watermark-opacity').value), 20); assert.equal(model.pages, pages);
    }
    for (const dialog of ['help-dialog', 'tool-help-dialog', 'save-dialog', 'fullscreen-preview']) {
      const { $, model, key } = guardedSetup(tool);
      $(dialog).open = true;
      const pages = model.pages;
      assert.equal(key('ArrowRight').defaultPrevented, undefined);
      assert.equal(Number($('watermark-opacity').value), 20); assert.equal(model.pages, pages);
    }
    const { context, key } = guardedSetup(tool);
    context.model.activeId = null;
    assert.equal(key('ArrowRight').defaultPrevented, undefined);
  }
  for (const tool of ['select', 'pen', 'text', 'stamp']) {
    const { $, key } = setup(tool);
    assert.equal(key('ArrowRight').defaultPrevented, undefined);
    assert.equal(Number($('watermark-opacity').value), 20);
  }
});
