import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { EditorModel } from '../src/model.js';
import { paintOverlay, strokeLayout, moveStroke, buildPdf, imagePlacement } from '../src/pdf.js';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const slice = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));
const script = [
  slice('function updateControls()', '\nfunction refresh()'),
  slice('function enableSelection(', "\n$('open-select').addEventListener"),
  slice('function openPreviewMenu(', '\nfor (const name of previewMenus)'),
  slice('function selectedText()', '\nfunction textSettings()'),
  slice('function paintTextPreview()', '\nfunction positionTextEditor()'),
  slice('function finishTextEdit(', '\n// Commit before toolbar/page/export'),
  slice('function textFormatRange()', '\nfunction deleteSelectedAnnotation()'),
  slice('function moveSelectedAnnotation(', '\nfunction refreshAnnotationHandles()'),
].join('\n');

function setup(tool = 'pen', opacity = 0.75) {
  const canvas = createCanvas(200, 200), nodes = new Map(), documentHandlers = {};
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', style: {}, dataset: {}, handlers: {}, attributes: {},
      classList: { toggle() {} }, disabled: false,
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name]; },
      addEventListener(type, handler) { this.handlers[type] = handler; },
      querySelectorAll() { return []; }, closest() { return null; }, getContext: () => canvas.getContext('2d'),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }),
    });
    return nodes.get(id);
  };
  const model = new EditorModel();
  const original = { id: 'stroke', tool, color: '#ff0000', width: 4, points: [[30, 40], [130, 40]] };
  if (opacity !== undefined) original.opacity = opacity;
  const other = { ...original, id: 'other', points: [[30, 100], [130, 100]] };
  const text = { id: 'text', tool: 'text', text: 'Note', color: '#222222', fontSize: 12, points: [[10, 160]] };
  const watermark = { text: 'DRAFT', color: '#736c90', opacity: 0.2 };
  model.commit([{ id: 'page', strokes: [original, other, text], watermark },
    { id: 'other-page', strokes: [other] }]);
  const context = vm.createContext({ $, model, canvas, paintOverlay, strokeLayout, moveStroke,
    viewport: { width: 200, height: 200, scale: 1,
      convertToPdfPoint: (x, y) => [x, y], convertToViewportPoint: (x, y) => [x, y] },
    document: { querySelectorAll: selector => selector === 'button, input, select, textarea' ? [...nodes.values()] : [],
      addEventListener(type, handler) { documentHandlers[type] = handler; } },
    busy: false, selectedAnnotationId: null, selectedStrokeIds: new Set(), annotationFormatPreview: null, strokeFormatSession: null, textEdit: null,
    textEnabled: false, penEnabled: false, activePreviewMenu: 'select', previewMenuOpen: false,
    stroke: null, annotationDrag: null, pageDrag: null,
    previewMenus: ['rotation', 'pen', 'watermark'], previewZoom: 1, minPreviewZoom: 0.5, maxPreviewZoom: 4,
    toolDescriptions: { 'open-text': 'テキスト', 'open-pen': 'ペン' },
    resetPreviewMenu() { context.activePreviewMenu = 'select'; },
    refreshThumbnails() {}, status() {},
    refreshAnnotationHandles() {
      const annotation = context.annotationFormatPreview || context.selectedStroke();
      if (annotation) context.positionAnnotationHandle($('handle'), annotation);
    },
  });
  vm.runInContext(script, context);
  context.selectAnnotation(original);
  return { context, $, model, original, other, text, watermark, canvas, documentHandlers };
}

const shortcut = (key, extra = {}) => ({ key, ctrlKey: true, target: { closest: () => null },
  preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });

function multipleSetup() {
  const env = setup();
  env.other.width = 8; env.other.opacity = 0.3;
  env.context.selectAnnotation(env.other, { toggle: true });
  return env;
}

function installHandles({ context, $ }) {
  const handles = [];
  context.document.createElement = () => ({ style: {}, dataset: {}, handlers: {}, attributes: {}, classList: { toggle() {} },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    remove() { handles.splice(handles.indexOf(this), 1); },
    focus() {}, setPointerCapture() { this.captured = true; },
    hasPointerCapture() { return !!this.captured; }, releasePointerCapture() { this.captured = false; },
  });
  $('text-handles').querySelectorAll = () => handles;
  $('text-handles').append = handle => handles.push(handle);
  context.pageAnnotations = () => context.model.active.strokes.filter(item => item.tool !== 'text');
  vm.runInContext(slice('function refreshAnnotationHandles()', '\nfunction pdfPoint('), context);
  context.refreshAnnotationHandles();
  return handles;
}

const pointer = (x, y, extra = {}) => ({ button: 0, isPrimary: true, pointerId: 1,
  clientX: x, clientY: y, preventDefault() {}, ...extra });

test('modifier clicks toggle stroke selection, retain all handles, and leave history and Redo intact', () => {
  const env = setup(), { context, model, other, original } = env;
  const handles = installHandles(env), second = handles.find(item => item.dataset.annotationId === other.id);
  const history = model.past.length; model.future.push(model.snapshot());
  second.handlers.pointerdown(pointer(40, 100, { shiftKey: true }));
  assert.equal(context.selectedStrokes().length, 2);
  assert.ok(handles.every(item => item.attributes['aria-pressed'] === 'true'));
  assert.equal(context.annotationDrag, null);
  second.handlers.click({ detail: 0, ctrlKey: true });
  assert.equal(context.selectedStrokes().length, 1);
  assert.equal(context.selectedAnnotationId, original.id);
  context.selectAnnotation(other, { toggle: true });
  context.selectAnnotation(model.active.strokes[1], { preserve: true });
  assert.equal(context.selectedStrokes().length, 2);
  context.selectAnnotation(original, { toggle: true });
  context.selectAnnotation(other, { toggle: true });
  assert.equal(context.selectedAnnotationId, null);
  assert.equal(context.selectedStrokes().length, 0);
  assert.equal(model.past.length, history); assert.equal(model.future.length, 1);
});

test('group shortcuts preserve different widths and transparencies with one Undo per operation', () => {
  const { context, model, original, other, $ } = multipleSetup();
  const history = model.past.length;
  context.handlePenShortcut(shortcut('ArrowUp'));
  assert.deepEqual(model.active.strokes.slice(0, 2).map(item => item.width), [5, 9]);
  assert.equal(model.past.length, history + 1);
  context.handlePenShortcut(shortcut('ArrowRight'));
  const changed = model.active.strokes.slice(0, 2);
  assert.ok(Math.abs(changed[0].opacity - 0.74) < 1e-8);
  assert.ok(Math.abs(changed[1].opacity - 0.29) < 1e-8);
  assert.equal(context.selectedStrokes().length, 2);
  assert.equal($('pen-menu-title').textContent, '選択した描画（2件）');
  assert.equal(model.past.length, history + 2);
  model.undo(); model.undo();
  assert.equal(model.active.strokes[0], original); assert.equal(model.active.strokes[1], other);
  context.selectAnnotation(other, { preserve: true });
  assert.equal(context.selectedStrokes().length, 2);
  model.redo(); model.redo();
  assert.equal(model.active.strokes[0], changed[0]); assert.equal(model.active.strokes[1], changed[1]);
});

test('group sliders preview each original baseline without accumulating deltas and commit once', () => {
  const { context, $, model, original, other } = multipleSetup();
  const history = model.past.length;
  $('pen-width').value = '9'; $('pen-width').handlers.input();
  $('pen-width').value = '11'; $('pen-width').handlers.input();
  assert.deepEqual([...context.strokeFormatSession.previews.values()].map(item => item.width), [7, 11]);
  assert.equal(model.active.strokes[0], original); assert.equal(model.active.strokes[1], other);
  assert.equal(model.past.length, history);
  $('pen-width').handlers.change(); $('pen-width').handlers.blur();
  assert.deepEqual(model.active.strokes.slice(0, 2).map(item => item.width), [7, 11]);
  assert.equal(model.past.length, history + 1);
  $('pen-transparency').value = '75'; $('pen-transparency').handlers.change();
  assert.ok(Math.abs(model.active.strokes[0].opacity - 0.7) < 1e-8);
  assert.ok(Math.abs(model.active.strokes[1].opacity - 0.25) < 1e-8);
  $('pen-color').value = '#008000'; $('pen-color').handlers.change();
  assert.ok(model.active.strokes.slice(0, 2).every(item => item.color === '#008000'));
  assert.equal(model.active.strokes[2].color, '#222222');
});

test('group shortcuts stop all strokes at either limit regardless of which stroke is the anchor', () => {
  for (const anchorFirst of [false, true]) for (const [property, values, key, reverse] of [
    ['width', [4, 40], 'ArrowUp', 'ArrowDown'], ['width', [1, 8], 'ArrowDown', 'ArrowUp'],
    ['opacity', [0.75, 0.05], 'ArrowRight', 'ArrowLeft'], ['opacity', [1, 0.3], 'ArrowLeft', 'ArrowRight'],
  ]) {
    const { context, model, original, other, $ } = multipleSetup();
    original[property] = values[0]; other[property] = values[1];
    context.selectAnnotation(anchorFirst ? original : other, { preserve: true });
    const history = model.past.length; model.future.push(model.snapshot());
    for (let i = 0; i < 3; i++) assert.equal(context.handlePenShortcut(shortcut(key)), true);
    assert.equal(model.active.strokes[0], original); assert.equal(model.active.strokes[1], other);
    assert.equal(model.past.length, history); assert.equal(model.future.length, 1);
    const id = property === 'width' ? 'pen-width' : 'pen-transparency';
    const anchor = anchorFirst ? original : other;
    assert.equal(Number($(id).value), property === 'width' ? anchor.width : Math.round((1 - anchor.opacity) * 100));
    context.handlePenShortcut(shortcut(reverse));
    assert.equal(model.past.length, history + 1);
    const after = model.active.strokes;
    assert.ok(Math.abs((after[1][property] - after[0][property]) - (values[1] - values[0])) < 1e-8);
    model.undo(); assert.equal(model.active.strokes[0], original); assert.equal(model.active.strokes[1], other);
  }
});

test('group sliders stop at the first boundary and reverse without changing the original balance', () => {
  for (const [id, property, before, request, stopped, reverse, reversed] of [
    ['pen-width', 'width', [4, 38], 40, [6, 40], 5, [5, 39]],
    ['pen-width', 'width', [3, 8], 1, [1, 6], 7, [2, 7]],
    ['pen-transparency', 'opacity', [0.75, 0.07], 95, [0.73, 0.05], 94, [0.74, 0.06]],
    ['pen-transparency', 'opacity', [0.98, 0.3], 0, [1, 0.32], 69, [0.99, 0.31]],
  ]) {
    const { context, $, model, original, other } = multipleSetup();
    original[property] = before[0]; other[property] = before[1];
    // The upper cases constrain the non-anchor stroke; the lower cases constrain the first stroke.
    context.selectAnnotation(property === 'width' && request === 40 ? original : other, { preserve: true });
    const history = model.past.length;
    $(id).value = String(request); $(id).handlers.input();
    const preview = [...context.strokeFormatSession.previews.values()];
    for (let i = 0; i < 2; i++) assert.ok(Math.abs(preview[i][property] - stopped[i]) < 1e-8);
    assert.equal(model.past.length, history);
    $(id).handlers.change();
    for (let i = 0; i < 2; i++) assert.ok(Math.abs(model.active.strokes[i][property] - stopped[i]) < 1e-8);
    assert.equal(model.past.length, history + 1);
    model.undo(); context.selectAnnotation(property === 'width' && request === 40 ? original : other, { preserve: true });
    $(id).value = String(request); $(id).handlers.input();
    $(id).value = String(reverse); $(id).handlers.input(); $(id).handlers.change();
    for (let i = 0; i < 2; i++) assert.ok(Math.abs(model.active.strokes[i][property] - reversed[i]) < 1e-8);
    model.undo(); assert.equal(model.active.strokes[0], original); assert.equal(model.active.strokes[1], other);
  }
});

test('fractional transparency stops the whole selection at the boundary without rounding away the preview', () => {
  const { context, $, model, original, other } = multipleSetup();
  other.opacity = 0.053;
  context.selectAnnotation(original, { preserve: true });
  $('pen-transparency').value = '95'; $('pen-transparency').handlers.input();
  $('pen-transparency').handlers.change();
  assert.ok(Math.abs(model.active.strokes[0].opacity - 0.747) < 1e-8);
  assert.ok(Math.abs(model.active.strokes[1].opacity - 0.05) < 1e-8);
  const history = model.past.length;
  context.handlePenShortcut(shortcut('ArrowRight'));
  assert.equal(model.past.length, history);
  context.handlePenShortcut(shortcut('ArrowLeft'));
  assert.ok(Math.abs(model.active.strokes[0].opacity - 0.757) < 1e-8);
  assert.ok(Math.abs(model.active.strokes[1].opacity - 0.06) < 1e-8);
});

test('returning a group slider to its original value creates no history and keeps Redo', () => {
  const { context, $, model, original, other } = multipleSetup();
  const history = model.past.length; model.future.push(model.snapshot());
  $('pen-width').value = '10'; $('pen-width').handlers.input();
  $('pen-width').value = '8'; $('pen-width').handlers.change();
  assert.equal(model.active.strokes[0], original); assert.equal(model.active.strokes[1], other);
  assert.equal(model.past.length, history); assert.equal(model.future.length, 1);
  assert.equal(context.strokeFormatSession, null);
  other.opacity = 0.333;
  context.syncPenControls();
  $('pen-transparency').handlers.change();
  assert.equal(model.past.length, history); assert.equal(model.future.length, 1);
  context.handlePenShortcut(shortcut('ArrowRight'));
  assert.ok(Math.abs(model.active.strokes[1].opacity - 0.323) < 1e-8);
});

test('group keyboard movement and pointer dragging preserve spacing and commit the group atomically', () => {
  const env = multipleSetup(), { context, model, original, other } = env;
  context.moveSelectedAnnotation(10, 5);
  assert.equal(model.active.strokes[0].points[0][0], original.points[0][0] + 10);
  assert.equal(model.active.strokes[1].points[0][1], other.points[0][1] + 5);
  model.undo();
  const handles = installHandles(env), second = handles.find(item => item.dataset.annotationId === other.id);
  const history = model.past.length;
  second.handlers.pointerdown(pointer(50, 100));
  second.handlers.pointermove(pointer(1000, 1000));
  assert.equal(model.active.strokes[0], original);
  assert.equal(context.annotationDrag.currents.length, 2);
  second.handlers.pointerup(pointer(1000, 1000));
  const [first, last] = model.active.strokes;
  assert.equal(last.points[0][0] - first.points[0][0], other.points[0][0] - original.points[0][0]);
  assert.equal(last.points[0][1] - first.points[0][1], other.points[0][1] - original.points[0][1]);
  assert.equal(first.width, original.width); assert.equal(last.width, other.width);
  assert.ok(strokeLayout(last, context.viewport).right <= 200 + 1e-8);
  assert.ok(strokeLayout(last, context.viewport).bottom <= 200 + 1e-8);
  assert.equal(context.selectedStrokes().length, 2);
  assert.equal(model.past.length, history + 1);
  model.undo(); assert.equal(model.active.strokes[0], original); assert.equal(model.active.strokes[1], other);
  second.handlers.pointerdown(pointer(50, 100));
  second.handlers.pointermove(pointer(65, 110));
  second.handlers.pointercancel();
  assert.equal(context.annotationDrag, null);
  assert.equal(model.active.strokes[0], original); assert.equal(model.active.strokes[1], other);
});

test('group deletion is atomic and clearing selection excludes prior members on the next selection', () => {
  const env = multipleSetup(), { context, model, original, other, text } = env;
  vm.runInContext(slice('function deleteSelectedAnnotation()', "\non('delete-text'"), context);
  context.refresh = () => { context.updateControls(); };
  const history = model.past.length;
  context.deleteSelectedAnnotation();
  assert.deepEqual(model.active.strokes, [text]); assert.equal(model.past.length, history + 1);
  model.undo(); assert.equal(model.active.strokes[0], original); assert.equal(model.active.strokes[1], other);
  context.selectAnnotation(original); context.selectAnnotation(other, { toggle: true });
  context.enableSelection(); context.selectAnnotation(original);
  assert.equal(context.selectedStrokes().length, 1);
  context.handlePenShortcut(shortcut('ArrowUp'));
  assert.equal(model.active.strokes[1], other);
});

test('Ctrl+arrows adjust only the selected stroke and restore each step through Undo/Redo', () => {
  for (const tool of [undefined, 'pen', 'line', 'ellipse', 'rectangle']) {
    const { context, $, model, original, other, documentHandlers } = setup(tool);
    if (tool === undefined) delete original.tool;
    vm.runInContext(slice("document.addEventListener('keydown', event => {", '\nlet resizeTimer;'), context);
    const history = model.past.length;
    for (const [key, width, transparency] of [
      ['ArrowUp', 5, 25], ['ArrowDown', 4, 25], ['ArrowRight', 4, 26], ['ArrowLeft', 4, 25],
    ]) {
      const event = shortcut(key);
      documentHandlers.keydown(event);
      assert.equal(event.defaultPrevented && event.stopped, true);
      const formatted = model.active.strokes[0];
      assert.equal(formatted.width, width);
      assert.ok(Math.abs(formatted.opacity - (1 - transparency / 100)) < 1e-8);
      assert.equal(Number($('pen-width-value').value), width);
      assert.equal($('pen-transparency-value').value, `${transparency}%`);
      assert.equal(formatted.points, original.points); assert.equal(formatted.color, original.color);
      assert.equal(model.active.strokes[1], other);
      assert.equal(context.selectedAnnotationId, original.id); assert.equal(context.previewMenuOpen, false);
      model.undo(); model.redo(); assert.equal(model.active.strokes[0], formatted);
    }
    assert.equal(model.past.length, history + 4);
    for (let i = 0; i < 4; i++) model.undo();
    assert.equal(model.active.strokes[0], original);
  }
});

test('starting new drawing resets width and transparency, while reopening settings preserves the current drawing defaults', () => {
  for (const selection of ['multiple', 'single', 'none']) {
    const { context, $, model, original, other } = multipleSetup();
    if (selection === 'single') context.selectAnnotation(original);
    if (selection === 'none') context.enableSelection();
    const history = model.past.length;
    context.openPreviewMenu('pen');
    assert.equal(Number($('pen-width').value), 3);
    assert.equal(Number($('pen-transparency').value), 0);
    assert.equal($('pen-width-value').value, '3');
    assert.equal($('pen-transparency-value').value, '0%');
    assert.equal(model.past.length, history);
    assert.equal(model.active.strokes[0], original); assert.equal(model.active.strokes[1], other);
    assert.equal(context.selectedAnnotationId, null);

    context.uid = () => 'new-stroke';
    context.pdfPoint = event => [event.clientX, event.clientY];
    $('pen-tool').value = 'pen'; $('ink-canvas').setPointerCapture = () => {};
    vm.runInContext(slice("$('ink-canvas').addEventListener('pointerdown', event => {", "\n$('help').addEventListener"), context);
    $('ink-canvas').handlers.pointerdown(pointer(20, 20));
    $('ink-canvas').handlers.pointerup(pointer(60, 20, { type: 'pointerup' }));
    const added = model.active.strokes.at(-1);
    assert.equal(added.width, 3); assert.equal(added.opacity, 1);

    $('pen-width').value = '7'; $('pen-width').handlers.change();
    $('pen-transparency').value = '30'; $('pen-transparency').handlers.change();
    context.togglePreviewMenu('pen'); context.togglePreviewMenu('pen');
    assert.equal(Number($('pen-width').value), 7);
    assert.equal(Number($('pen-transparency').value), 30);
    context.enableSelection(); context.openPreviewMenu('pen');
    assert.equal(Number($('pen-width').value), 3);
    assert.equal(Number($('pen-transparency').value), 0);
    assert.equal(model.active.strokes.at(-1), added);
    assert.equal(model.past.length, history + 1);
  }
});

test('pen-mode shortcuts change settings for future drawings without changing existing strokes or history', () => {
  const { context, $, model, original } = setup();
  context.enableSelection(); context.openPreviewMenu('pen');
  const history = model.past.length;
  for (const key of ['ArrowUp', 'ArrowRight', 'ArrowRight']) {
    assert.equal(context.handlePenShortcut(shortcut(key, { repeat: true })), true);
  }
  assert.equal(Number($('pen-width').value), 4);
  assert.equal(Number($('pen-transparency').value), 2);
  assert.equal(model.active.strokes[0], original); assert.equal(model.past.length, history);
  assert.equal(context.penEnabled, true);
});

test('shortcut limits and legacy opacity avoid redundant history and preserve Redo', () => {
  const { context, $, model, original } = setup();
  delete original.opacity;
  context.selectAnnotation(original);
  const history = model.past.length;
  model.future.push(model.snapshot());
  assert.equal(context.handlePenShortcut(shortcut('ArrowLeft')), true);
  assert.equal(model.past.length, history); assert.equal(model.future.length, 1);
  for (const [id, value, key] of [
    ['pen-width', '1', 'ArrowDown'], ['pen-width', '40', 'ArrowUp'],
    ['pen-transparency', '95', 'ArrowRight'], ['pen-transparency', '0', 'ArrowLeft'],
  ]) {
    $(id).value = value; $(id).handlers.change();
    const before = model.active.strokes[0], count = model.past.length;
    assert.equal(context.handlePenShortcut(shortcut(key)), true);
    assert.equal(Number($(id).value), Number(value));
    assert.equal(model.active.strokes[0], before); assert.equal(model.past.length, count);
  }
});

test('pen shortcuts yield to text, editable fields, dialogs, IME and gestures in progress', () => {
  const { context, model, original } = setup();
  const history = model.past.length;
  for (const extra of [{ ctrlKey: false }, { altKey: true }, { shiftKey: true },
    { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true },
    { target: { closest: () => ({}) } }]) {
    assert.equal(context.handlePenShortcut(shortcut('ArrowUp', extra)), false);
  }
  for (const flag of ['busy', 'stroke', 'annotationDrag', 'pageDrag', 'textEdit']) {
    context[flag] = true;
    assert.equal(context.handlePenShortcut(shortcut('ArrowUp')), false);
    context[flag] = flag === 'busy' ? false : null;
  }
  for (const id of ['help-dialog', 'save-dialog', 'fullscreen-preview']) {
    context.$(id).open = true;
    assert.equal(context.handlePenShortcut(shortcut('ArrowRight')), false);
    context.$(id).open = false;
  }
  context.selectedAnnotationId = 'text';
  assert.equal(context.handlePenShortcut(shortcut('ArrowUp')), false);
  context.selectedAnnotationId = 'watermark';
  assert.equal(context.handlePenShortcut(shortcut('ArrowRight')), false);
  context.selectedAnnotationId = null;
  assert.equal(context.handlePenShortcut(shortcut('ArrowUp')), false);
  assert.equal(model.active.strokes[0], original); assert.equal(model.past.length, history);
});

test('stroke selection loads styles, keeps history, and opens formatting from the pen icon', () => {
  const { context, $, model, original } = setup();
  const history = model.past.length;
  model.future.push(model.snapshot());
  context.selectAnnotation(original);
  assert.equal($('pen-color').value, original.color);
  assert.equal($('pen-width').value, original.width);
  assert.equal($('pen-transparency').value, 25);
  assert.equal(context.previewMenuOpen, false);
  assert.equal($('pen-shape-settings').hidden, true);
  assert.equal($('pen-drawing-settings').hidden, true);
  assert.equal($('stroke-selection-actions').hidden, false);
  assert.equal($('open-pen').disabled, false);
  assert.equal($('open-pen').attributes['aria-pressed'], 'true');
  for (const tool of ['select', 'text', 'rotation', 'watermark']) {
    assert.equal($(`open-${tool}`).disabled, true);
    context.togglePreviewMenu(tool);
    assert.equal(context.selectedAnnotationId, original.id);
    assert.equal(context.previewMenuOpen, false);
  }
  context.togglePreviewMenu('pen'); assert.equal($('panel-pen').hidden, false);
  context.togglePreviewMenu('pen'); assert.equal($('panel-pen').hidden, true);
  assert.equal(context.selectedAnnotationId, original.id);
  assert.equal(context.penEnabled, false);
  assert.equal(model.past.length, history); assert.equal(model.future.length, 1);
  context.enableSelection();
  for (const tool of ['select', 'pen', 'text', 'rotation', 'watermark']) assert.equal($(`open-${tool}`).disabled, false);
});

test('stroke style inputs preview live, resize the selection bounds, and commit once per gesture', () => {
  const { context, $, model, original, canvas } = setup();
  const history = model.past.length;
  $('pen-width').value = '12'; $('pen-width').handlers.input();
  $('pen-width').value = '20'; $('pen-width').handlers.input();
  assert.equal(parseFloat($('handle').style.height), 20);
  assert.equal(model.active.strokes[0], original);
  assert.equal(model.past.length, history);
  const pixel = canvas.getContext('2d').getImageData(70, 47, 1, 1).data;
  assert.equal(pixel[0], 255); assert.ok(Math.abs(pixel[3] - 191) <= 1);
  $('pen-width').handlers.change(); $('pen-width').handlers.blur();
  assert.equal(model.active.strokes[0].width, 20);
  assert.equal(model.past.length, history + 1);
  model.undo(); context.selectAnnotation(model.active.strokes[0]);
  assert.equal($('pen-width').value, 4);
  model.redo(); context.selectAnnotation(model.active.strokes[0]);
  assert.equal($('pen-width').value, 20);
});

test('all pen shapes edit only the selected stroke, retaining geometry and other page content', () => {
  for (const tool of [undefined, 'pen', 'line', 'ellipse', 'rectangle']) {
    const { context, $, model, original, other, text, watermark } = setup(tool);
    if (tool === undefined) delete original.tool;
    const secondPage = model.pages[1];
    for (const [id, value] of [['pen-color', '#0000ff'], ['pen-width', '40'], ['pen-transparency', '95']]) {
      $(id).value = value; $(id).handlers.input(); $(id).handlers.change();
    }
    const formatted = model.active.strokes[0];
    assert.equal(formatted.color, '#0000ff'); assert.equal(formatted.width, 40);
    assert.ok(Math.abs(formatted.opacity - 0.05) < 1e-8);
    assert.equal(formatted.tool, original.tool); assert.equal(formatted.points, original.points);
    assert.equal(model.active.strokes[1], other); assert.equal(model.active.strokes[2], text);
    assert.equal(model.active.watermark, watermark); assert.equal(model.pages[1], secondPage);
    context.moveSelectedAnnotation(10, 0);
    assert.equal(model.active.strokes[0].points[0][0], original.points[0][0] + 10);
    assert.equal(model.active.strokes[0].color, formatted.color);
    model.undo(); assert.equal(model.active.strokes[0], formatted);
    model.undo(); model.undo(); model.undo(); assert.equal(model.active.strokes[0], original);
    model.redo(); model.redo(); model.redo(); assert.equal(model.active.strokes[0], formatted);
  }
});

test('legacy opacity defaults and unchanged gestures preserve Undo and Redo', () => {
  const { context, $, model, original } = setup();
  delete original.opacity;
  context.selectAnnotation(original);
  assert.equal($('pen-transparency').value, 0);
  const history = model.past.length;
  model.future.push(model.snapshot());
  $('pen-transparency').handlers.change();
  $('pen-transparency').value = '70'; $('pen-transparency').handlers.input();
  $('pen-transparency').value = '0'; $('pen-transparency').handlers.change();
  assert.equal(model.active.strokes[0], original);
  assert.equal(model.past.length, history); assert.equal(model.future.length, 1);
});

test('pending stroke settings commit before deselection, save preparation and new drawing', () => {
  for (const action of ['enableSelection', 'finishTextEdit', 'openPreviewMenu']) {
    const { context, $, model } = setup();
    $('pen-color').value = '#008000'; $('pen-color').handlers.input();
    context[action]('pen');
    assert.equal(context.annotationFormatPreview, null);
    assert.equal(model.active.strokes[0].color, '#008000');
    if (action === 'openPreviewMenu') {
      assert.equal(context.penEnabled, true); assert.equal(context.selectedAnnotationId, null);
    }
  }
});

test('settings for new drawings do not modify existing strokes', () => {
  const { context, $, model, original } = setup();
  context.enableSelection(); context.openPreviewMenu('pen');
  const history = model.past.length;
  for (const [id, value] of [['pen-color', '#0000ff'], ['pen-width', '1'], ['pen-transparency', '0']]) {
    $(id).value = value; $(id).handlers.change();
  }
  assert.equal(model.active.strokes[0], original); assert.equal(model.past.length, history);
  assert.equal($('pen-shape-settings').hidden, false);
});

test('edited stroke color, width and transparency are retained in PDF output', async () => {
  const { context, $, model } = setup();
  const document = await PDFDocument.create(); document.addPage([200, 200]);
  const source = await pdfjs.getDocument({ data: await document.save() }).promise;
  let output;
  try {
    context.viewport = (await source.getPage(1)).getViewport({ scale: 1 });
    for (const [id, value] of [['pen-color', '#0000ff'], ['pen-width', '20'], ['pen-transparency', '70']]) {
      $(id).value = value; $(id).handlers.change();
    }
    const record = { ...model.active, sourceId: 'source', index: 0, rotation: 0,
      strokes: [model.active.strokes[0]], watermark: null };
    const overlay = createCanvas(200, 200);
    paintOverlay(overlay.getContext('2d'), record, context.viewport);
    const bytes = await buildPdf([record], new Map([['source', { document, preview: source }]]), async () => ({
      bytes: new Uint8Array(overlay.toBuffer('image/png')), placement: imagePlacement(context.viewport),
    }));
    output = await pdfjs.getDocument({ data: bytes }).promise;
    const page = await output.getPage(1), actual = createCanvas(200, 200);
    await page.render({ canvasContext: actual.getContext('2d'), viewport: page.getViewport({ scale: 1 }) }).promise;
    const pixel = (x, y) => [...actual.getContext('2d').getImageData(x, y, 1, 1).data];
    const inside = pixel(70, 167);
    assert.ok(Math.abs(inside[0] - 178) <= 2 && Math.abs(inside[1] - 178) <= 2);
    assert.equal(inside[2], 255); assert.deepEqual(pixel(70, 173), [255, 255, 255, 255]);
  } finally { await source.loadingTask.destroy(); await output?.loadingTask.destroy(); }
});

test('PDF output retains the individual widths and transparencies after group adjustments', async () => {
  const { context, $, model } = multipleSetup();
  const document = await PDFDocument.create(); document.addPage([200, 200]);
  const source = await pdfjs.getDocument({ data: await document.save() }).promise;
  let output;
  try {
    context.viewport = (await source.getPage(1)).getViewport({ scale: 1 });
    context.handlePenShortcut(shortcut('ArrowUp'));
    context.handlePenShortcut(shortcut('ArrowRight'));
    $('pen-color').value = '#0000ff'; $('pen-color').handlers.change();
    const record = { ...model.active, sourceId: 'source', index: 0, rotation: 0,
      strokes: model.active.strokes.slice(0, 2), watermark: null };
    const overlay = createCanvas(200, 200);
    paintOverlay(overlay.getContext('2d'), record, context.viewport);
    const bytes = await buildPdf([record], new Map([['source', { document, preview: source }]]), async () => ({
      bytes: new Uint8Array(overlay.toBuffer('image/png')), placement: imagePlacement(context.viewport),
    }));
    output = await pdfjs.getDocument({ data: bytes }).promise;
    const page = await output.getPage(1), actual = createCanvas(200, 200);
    await page.render({ canvasContext: actual.getContext('2d'), viewport: page.getViewport({ scale: 1 }) }).promise;
    const pixel = (x, y) => [...actual.getContext('2d').getImageData(x, y, 1, 1).data];
    assert.ok(Math.abs(pixel(70, 160)[0] - 66) <= 2);
    assert.ok(Math.abs(pixel(70, 100)[0] - 181) <= 2);
    assert.equal(pixel(70, 160)[2], 255); assert.equal(pixel(70, 100)[2], 255);
    assert.deepEqual(pixel(70, 164), [255, 255, 255, 255]);
    assert.ok(pixel(70, 103)[0] < 240);
  } finally { await source.loadingTask.destroy(); await output?.loadingTask.destroy(); }
});
