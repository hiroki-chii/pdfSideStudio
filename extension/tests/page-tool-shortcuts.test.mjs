import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { EditorModel, normalizeRotation } from '../src/model.js';
import { DEFAULT_WATERMARK_FONT_SIZE } from '../src/pdf.js';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const slice = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));

function setup(tool = 'watermark') {
  const nodes = new Map(), handlers = {}, actions = {};
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', handlers: {}, get valueAsNumber() { return Number(this.value); },
      addEventListener(type, handler) { this.handlers[type] = handler; },
    });
    return nodes.get(id);
  };
  $('watermark-text').value = 'DRAFT'; $('watermark-color').value = '#736c90';
  Object.assign($('watermark-size'), { value: '36', min: '8', max: '96' });
  $('watermark-position').value = 'top-center'; $('rotation-scope').value = 'active';
  const watermark = { text: 'Original', color: '#123456', opacity: 0.3, points: [[20, 30]] };
  const model = new EditorModel();
  model.commit([{ id: 'a', rotation: 0, strokes: [], watermark },
    { id: 'b', rotation: 270, strokes: [], watermark: null }]);
  const context = vm.createContext({ $, model, normalizeRotation, DEFAULT_WATERMARK_FONT_SIZE, editorTab: true,
    document: { addEventListener(type, handler) { handlers[type] = handler; } },
    activePreviewMenu: tool, selectedAnnotationId: null, viewport: {},
    busy: false, stroke: null, annotationDrag: null, pageDrag: null, textEdit: null,
    selectedAnnotation: () => context.selectedAnnotationId ? { tool: 'text' } : null,
    activeRequired: () => model.active, refresh() {}, status() {}, navigatePage() {}, moveSelectedAnnotation() {},
    refreshAnnotationHandles() {}, refreshThumbnails() {}, updateControls() {},
    on(id, action) { actions[id] = action; }, run(action) { action(); },
    handleTextShortcut: () => false, handlePenShortcut: () => false,
  });
  vm.runInContext([
    slice('function rotate(', '\nasync function printPdf()'),
    slice('function syncWatermarkControls()', '\nfunction pageActionRequired('),
    slice('function handlePageToolShortcut(', '\nfunction deleteSelectedAnnotation()'),
    slice("document.addEventListener('keydown', event => {", '\nlet resizeTimer;'),
  ].join('\n'), context);
  function key(key, extra = {}) {
    const event = { key, ctrlKey: true, target: { closest: () => null },
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    handlers.keydown(event);
    return event;
  }
  return { $, model, context, actions, key, watermark };
}

test('the watermark form applies or removes its settings on all pages in one history entry', () => {
  const form = html.match(/<section id="panel-watermark"[^>]*>([\s\S]*?)<\/section>/)[1];
  assert.deepEqual(Array.from(form.matchAll(/<(?:input|select) id="([^"]+)"/g), match => match[1]),
    ['watermark-text', 'watermark-color', 'watermark-size', 'watermark-position']);
  assert.match(form, /id="watermark-size"[^>]*min="8" max="96" step="1" value="36"/);
  assert.deepEqual(Array.from(form.matchAll(/<option value="([^"]+)"/g), match => match[1]),
    ['top-left', 'top-center', 'top-right', 'middle-left', 'center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']);
  assert.match(form, /id="apply-watermark"[^>]*>適用<\/button>/);
  assert.match(form, /id="remove-watermark"[^>]*>削除<\/button>/);
  const { $, model, actions, watermark } = setup();
  const history = model.past.length;
  $('watermark-text').value = '   ';
  assert.throws(actions['apply-watermark'], /透かしのテキスト/);
  $('watermark-text').value = ' DRAFT ';
  $('watermark-size').value = '97';
  assert.throws(actions['apply-watermark'], /8〜96 pt/);
  $('watermark-size').value = '48';
  actions['apply-watermark']();
  const applied = { ...model.documentWatermark };
  assert.deepEqual(applied, { text: 'DRAFT', color: '#736c90', position: 'top-center', fontSize: 48 });
  assert.equal(model.past.length, history + 1);
  assert.ok(model.pages.every(page => page.watermark === model.documentWatermark));
  model.undo();
  assert.equal(model.active.watermark, watermark);
  assert.equal(model.pages[1].watermark, null);
  model.redo();
  model.commit([...model.pages, { id: 'c', rotation: 90, strokes: [], watermark: null }]);
  assert.ok(model.pages.every(page => page.watermark === model.documentWatermark));
  actions['remove-watermark']();
  assert.ok(model.pages.every(page => page.watermark === null));
  assert.equal(model.documentWatermark, null);
  model.undo();
  assert.deepEqual({ ...model.documentWatermark }, applied);
  assert.ok(model.pages.every(page => page.watermark === model.documentWatermark));
});

test('confirming each watermark setting updates all pages only after application', () => {
  const { $, model, actions, context } = setup();
  const text = $('watermark-text'), color = $('watermark-color'), position = $('watermark-position'), size = $('watermark-size');
  const history = model.past.length;
  text.value = 'Original draft';
  text.handlers.change();
  assert.equal(model.past.length, history);
  assert.equal(model.documentWatermark, undefined);
  actions['apply-watermark']();

  const assertApplied = expected => {
    assert.deepEqual({ ...model.documentWatermark }, expected);
    assert.ok(model.pages.every(page => page.watermark === model.documentWatermark));
  };
  const original = { text: 'Original draft', color: '#736c90', position: 'top-center', fontSize: 36 };
  const withText = { ...original, text: 'Revised' };
  text.value = ' Revised ';
  text.handlers.keydown({ key: 'Enter', isComposing: true });
  assertApplied(original);
  text.handlers.keydown({ key: 'Enter', preventDefault() {} });
  assertApplied(withText);
  text.handlers.change();
  assert.equal(model.past.length, history + 2);

  color.value = '#aa1122';
  color.handlers.change();
  const withColor = { ...withText, color: '#aa1122' };
  assertApplied(withColor);
  position.value = 'bottom-right';
  position.handlers.change();
  const withPosition = { ...withColor, position: 'bottom-right' };
  assertApplied(withPosition);
  size.value = '64';
  size.handlers.keydown({ key: 'Enter', preventDefault() {} });
  const withSize = { ...withPosition, fontSize: 64 };
  assertApplied(withSize);
  for (const invalid of ['', '5', '37.5', '97']) {
    size.value = invalid;
    size.handlers.change();
    assert.equal(Number(size.value), 64);
    assertApplied(withSize);
  }
  text.value = '  ';
  text.handlers.change();
  assert.equal(text.value, 'Revised');
  actions['apply-watermark']();
  assert.equal(model.past.length, history + 5);
  model.undo();
  context.syncWatermarkControls();
  assert.equal(Number(size.value), 36);
  assertApplied(withPosition);
  model.redo();
  context.syncWatermarkControls();
  assert.equal(Number(size.value), 64);
  assertApplied(withSize);

  actions['remove-watermark']();
  position.value = 'center';
  position.handlers.change();
  assert.ok(model.pages.every(page => page.watermark === null));
});

test('watermark settings leave every former opacity shortcut unhandled', () => {
  const { $, model, key } = setup();
  const pages = model.pages;
  for (const direction of ['ArrowLeft', 'ArrowRight']) {
    assert.equal(key(direction).defaultPrevented, undefined);
    assert.equal(key(direction, { target: { closest: () => $('watermark-position') } }).defaultPrevented, undefined);
  }
  assert.equal(model.pages, pages);
  assert.equal($('watermark-position').value, 'top-center');
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
    const env = setup(tool === 'selected-text' ? 'rotation' : tool);
    if (tool === 'selected-text') env.context.selectedAnnotationId = 'text';
    return env;
  };
  for (const tool of ['watermark', 'rotation', 'selected-text']) {
    for (const extra of [{ ctrlKey: false }, { altKey: true }, { shiftKey: true }, { defaultPrevented: true },
      { isComposing: true }, { keyCode: 229 }, { target: { closest: () => ({}) } }]) {
      const { model, key } = guardedSetup(tool);
      const pages = model.pages, history = model.past.length;
      key('ArrowRight', extra);
      assert.equal(model.pages, pages); assert.equal(model.past.length, history);
    }
    for (const field of ['busy', 'stroke', 'annotationDrag', 'pageDrag', 'textEdit', 'viewport']) {
      const { model, context, key } = guardedSetup(tool);
      context[field] = field === 'viewport' ? null : true;
      const pages = model.pages;
      const event = key('ArrowRight');
      assert.equal(event.defaultPrevented, undefined);
      assert.equal(model.pages, pages);
    }
    for (const dialog of ['help-dialog', 'tool-help-dialog', 'save-dialog', 'fullscreen-preview']) {
      const { $, model, key } = guardedSetup(tool);
      $(dialog).open = true;
      const pages = model.pages;
      assert.equal(key('ArrowRight').defaultPrevented, undefined);
      assert.equal(model.pages, pages);
    }
    const { context, key } = guardedSetup(tool);
    context.model.activeId = null;
    assert.equal(key('ArrowRight').defaultPrevented, undefined);
  }
  for (const tool of ['select', 'pen', 'text', 'stamp']) {
    const { key } = setup(tool);
    assert.equal(key('ArrowRight').defaultPrevented, undefined);
  }
});
