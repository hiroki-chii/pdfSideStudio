import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { EditorModel, normalizeRotation } from '../src/model.js';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const slice = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));

function setup(editorTab = false) {
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: '', hidden: false, disabled: false, handlers: {}, children: [], attributes: {}, dataset: {},
      classList: { toggle() {} },
      addEventListener(type, handler) { this.handlers[type] = handler; },
      setAttribute(name, value) { this.attributes[name] = value; },
      querySelectorAll(selector) {
        return selector === '.text-handle' ? this.children.filter(child => child.className === 'text-handle') : this.children;
      },
      closest() { return null; },
      replaceChildren(...children) { this.children = children; },
    });
    return nodes.get(id);
  };
  const model = new EditorModel();
  model.commit([{ id: 'a', rotation: 0, strokes: [{ id: 'note', tool: 'text', text: 'Keep me' }],
    watermark: { text: 'DRAFT' } }, { id: 'b', rotation: 90, strokes: [], watermark: null }]);
  const context = vm.createContext({ $, model, editorTab,
    document: { querySelectorAll: () => [...nodes.values()], querySelector: $ },
    busy: false, stroke: null, annotationDrag: null, pageDrag: null, textEdit: null,
    selectedAnnotationId: null, activePreviewMenu: editorTab ? 'select' : 'rotation', previewMenuOpen: false,
    penEnabled: false, textEnabled: false, viewport: {}, previewZoom: 1, minPreviewZoom: 0.5, maxPreviewZoom: 4,
    previewMenus: ['rotation', 'pen', 'stamp', 'watermark'], toolDescriptions: {},
    selectedAnnotation: () => null, selectedText: () => null, selectedStroke: () => null,
    selectedTexts: () => [], selectedStrokes: () => [], positionTextTailHandle() {},
    resetPreviewMenu() { context.activePreviewMenu = editorTab ? 'select' : 'rotation'; },
    refreshThumbnails() {}, renderPreview() {}, revealActiveThumbnail() {}, updateEditorSidebarLayout() {},
  });
  for (const name of ['pen', 'text', 'stamp', 'watermark', 'select']) {
    $(`panel-${name}`).children.push($(`${name}-setting`));
  }
  $('rotation-scope').value = 'active';
  vm.runInContext(slice('function updateControls()', '\nfunction updateEditorSidebarLayout('), context);
  return { $, model, context };
}

test('side panel exposes only rotation settings across refresh, busy and empty states', () => {
  const { $, model, context } = setup();
  const original = model.pages[0];
  for (const busy of [false, true, false]) {
    context.busy = busy;
    context.previewMenuOpen = true;
    context.activePreviewMenu = 'pen';
    context.refresh();
    for (const name of ['select', 'pen', 'text', 'stamp', 'watermark']) {
      assert.equal($(`open-${name}`).hidden, true);
      assert.equal($(`open-${name}`).disabled, true);
      assert.equal($(`panel-${name}`).hidden, true);
      assert.equal($(`${name}-setting`).disabled, true);
    }
    assert.equal($('panel-rotation').hidden, false);
    assert.equal($('rotate-left').disabled, busy);
    assert.equal($('rotate-right').disabled, busy);
    assert.equal($('open-save').disabled, busy);
    for (const id of ['split', 'print']) {
      assert.equal($(id).hidden, true);
      assert.equal($(id).disabled, true);
    }
    assert.equal(model.pages[0], original, 'Synced annotations remain untouched');
  }
  model.commit([]);
  context.refresh();
  assert.equal($('panel-rotation').hidden, true);
  assert.equal($('.preview-toolbar').hidden, true);
  assert.equal($('open-save').hidden, true);
  model.undo(); context.refresh();
  assert.equal($('panel-rotation').hidden, false);
});

test('the tab keeps all tools, split and print available', () => {
  const { $, context } = setup(true);
  context.refresh();
  for (const name of ['select', 'pen', 'text', 'stamp', 'rotation', 'watermark']) {
    assert.equal($(`open-${name}`).hidden, false);
    assert.equal($(`open-${name}`).disabled, false);
  }
  for (const id of ['split', 'print']) assert.equal($(id).disabled, false);
});

test('side panel rotation stays compact and announces the selected target, while the tab keeps text buttons', () => {
  for (const editorTab of [false, true]) {
    const { $, context } = setup(editorTab);
    for (const all of [false, true]) {
      $('rotation-scope').value = all ? 'all' : 'active';
      context.refresh();
      assert.equal($('rotate-left').textContent, editorTab ? all ? '全2ページを左90°' : '↶ 左に90°' : '↶');
      assert.equal($('rotate-right').textContent, editorTab ? all ? '全2ページを右90°' : '↷ 右に90°' : '↷');
      const target = all ? '全2ページ' : '表示中の1ページ目';
      assert.equal($('rotate-left').attributes['aria-label'], `${target}を左に90度回転`);
      assert.equal($('rotate-right').attributes['aria-label'], `${target}を右に90度回転`);
    }
  }
});

test('side panel blocks annotation tools and removes annotation handles', () => {
  const { $, model, context } = setup();
  const before = model.sessionSnapshot();
  vm.runInContext([
    slice('function togglePreviewMenu(', "\n$('open-select').addEventListener"),
    slice('function openPreviewMenu(', '\nfor (const name of previewMenus)'),
    slice('function refreshAnnotationHandles()', '\nfunction pdfPoint('),
  ].join('\n'), context);
  for (const name of ['select', 'pen', 'text', 'stamp', 'watermark']) {
    context.togglePreviewMenu(name); context.openPreviewMenu(name);
  }
  const tailHandle = $('text-tail-handle');
  $('text-handles').children.push(tailHandle, { className: 'text-handle', remove() {
    $('text-handles').children = $('text-handles').children.filter(child => child === tailHandle);
  } });
  context.refreshAnnotationHandles();
  assert.deepEqual($('text-handles').children, [tailHandle], 'Keep the permanent tail handle used by updateControls');
  assert.deepEqual(model.sessionSnapshot(), before);
  assert.equal(context.activePreviewMenu, 'rotation');
});

test('side panel blocks split, print and watermark handlers but permits saving and rotation', () => {
  const { $, context } = setup();
  vm.runInContext(slice('function on(', "\non('open-editor-tab'"), context);
  context.run = action => action();
  const calls = [];
  for (const id of ['split', 'print', 'apply-watermark', 'remove-watermark', 'save', 'rotate-left']) {
    context.on(id, () => calls.push(id));
    $(id).handlers.click();
  }
  assert.deepEqual(calls, ['save', 'rotate-left']);
});

test('side panel rotates the active page or all pages while preserving tab annotations and Undo', () => {
  const { $, model, context } = setup();
  Object.assign(context, { normalizeRotation, activeRequired: () => model.active, status() {} });
  vm.runInContext(slice('function rotate(', '\nasync function printPdf()'), context);
  const before = model.pages;
  context.rotate(90);
  assert.deepEqual(model.pages.map(page => page.rotation), [90, 90]);
  assert.equal(model.pages[0].strokes, before[0].strokes);
  assert.equal(model.pages[0].watermark, before[0].watermark);
  $('rotation-scope').value = 'all';
  context.rotate(-90);
  assert.deepEqual(model.pages.map(page => page.rotation), [0, 0]);
  model.undo(); context.refresh();
  assert.deepEqual(model.pages.map(page => page.rotation), [90, 90]);
  model.redo(); context.refresh();
  assert.deepEqual(model.pages.map(page => page.rotation), [0, 0]);
});
