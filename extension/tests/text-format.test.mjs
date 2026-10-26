import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createCanvas } from '@napi-rs/canvas';
import { EditorModel } from '../src/model.js';
import { textFont, textFontFamily, textLayout, moveText, moveStroke, strokeLayout, paintOverlay } from '../src/pdf.js';
import { styledRuns, textStyle, textBackground, formatTextBackground, formatText, replaceText } from '../src/text-format.js';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const slice = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));
const script = [
  slice('function enableSelection(', '\nfunction togglePreviewMenu('),
  slice('function selectedText()', '\nfunction enableTextInsertion()'),
  slice('function enableTextInsertion()', "\n$('open-text').addEventListener"),
  slice('function togglePreviewMenu(', "\n$('open-select').addEventListener"),
  slice('function focusSelectedAnnotation()', "\n$('update-text').addEventListener"),
  slice('function positionTextEditor()', '\n// Commit before toolbar/page/export'),
  slice('function textFormatRange()', '\nfunction deleteSelectedAnnotation()'),
  slice('function moveSelectedAnnotation(', '\nfunction refreshAnnotationHandles()'),
].join('\n');

test('a text click edits without a menu, while a drag only moves the text', () => {
  for (const moved of [false, true]) {
    const { context, original } = setup();
    Object.assign(context, { annotationDrag: { pageId: 'page', original, current: original,
      pointerId: 1, moved, button: { hasPointerCapture: () => false } },
      previewMenuOpen: false, updateAnnotationDrag() {}, positionAnnotationHandle() {} });
    vm.runInContext(slice('function finishAnnotationDrag(', '\nfunction cancelAnnotationDrag()'), context);
    context.finishAnnotationDrag({ pointerId: 1 });
    assert.equal(context.previewMenuOpen, false);
    assert.equal(!!context.textEdit, !moved);
    if (!moved) assert.equal(context.textEdit.editor.value, original.text);
    assert.equal(context.annotationDrag, null);
  }
});

function setup() {
  const canvas = createCanvas(600, 800);
  const nodes = new Map();
  const node = () => ({ value: '', style: {}, dataset: {}, classList: { toggle() {} }, attributes: {}, handlers: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key] ?? null; },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    querySelectorAll() { return []; }, closest() { return null; }, getContext() { return canvas.getContext('2d'); },
    getBoundingClientRect() { return { width: 300 }; },
    setCustomValidity(value) { this.validityMessage = value; },
    selectionStart: 0, selectionEnd: 0,
    remove() {}, focus() { this.focused = true; }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  });
  const $ = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const model = new EditorModel();
  const original = { id: 'text', tool: 'text', text: 'Long line\nPDF', fontSize: 24,
    color: '#222222', rotation: 0, points: [[60, 100]] };
  model.commit([{ id: 'page', strokes: [original] }]);
  const viewport = { width: 600, height: 800, scale: 1, rotation: 0,
    convertToPdfPoint: (x, y) => [x, y], convertToViewportPoint: (x, y) => [x, y] };
  const errors = [];
  const context = vm.createContext({ $, model, viewport, textLayout, moveText, moveStroke, strokeLayout, paintOverlay, textFontFamily,
    styledRuns, textStyle, textBackground, formatTextBackground, formatText, replaceText,
    createTextEditor(annotation) {
      const editor = node(); editor.value = annotation.text;
      editor.getAnnotation = () => replaceText(context.textEdit?.draft || annotation, editor.value);
      editor.setAnnotation = value => { editor.value = value.text; editor.renderCount = (editor.renderCount || 0) + 1; };
      editor.setBackground = () => { editor.backgroundUpdated = true; };
      return editor;
    },
    busy: false, selectedAnnotationId: 'text', selectedStrokeIds: new Set(), selectedTextIds: new Set(),
    annotationFormatPreview: null, strokeFormatSession: null, textFormatSession: null, textEdit: null,
    textEnabled: false, textInsertionColor: '#222222', penEnabled: false, activePreviewMenu: 'text',
    previewMenuOpen: false, stroke: null, annotationDrag: null, pageDrag: null,
    previewMenus: ['rotation', 'pen', 'watermark'], previewZoom: 1, minPreviewZoom: 0.5, maxPreviewZoom: 4,
    toolDescriptions: { 'open-text': '配置' },
    selectedAnnotation: () => model.active?.strokes.find(item => item.id === context.selectedAnnotationId),
    selectedStroke: () => null,
    document: { createElement: node }, resetPreviewMenu() {},
    updateControls() { $('panel-text').hidden = !context.previewMenuOpen; },
    refreshAnnotationHandles() {}, refreshThumbnails() {}, paintTextPreview() {},
    status(message, kind) { if (kind === 'error') errors.push(message); },
  });
  vm.runInContext(script, context);
  context.selectAnnotation(original);
  return { context, $, model, original, errors };
}

test('editing framed and filled stamps preserves the frame, padded position, contrast and history', () => {
  for (const stampPattern of ['circle', 'circle-filled', 'square', 'square-filled']) {
    const { context, model, original } = setup();
    const stamp = { ...original, text: '12', textAlign: 'center', stampPattern, color: '#e05267' };
    model.update(new Set(['page']), page => ({ ...page, strokes: [stamp] }));
    context.startTextEdit(stamp);
    context.positionTextEditor();
    const editor = context.textEdit.editor;
    assert.ok(parseFloat(editor.style.paddingLeft) > 0);
    assert.ok(parseFloat(editor.style.paddingTop) > 0);
    assert.equal(editor.dataset.stampInk, stampPattern.endsWith('-filled') ? 'light' : '');
    assert.equal(editor.style.backgroundImage, 'none');
    editor.value = '123'; context.updateTextDraft();
    assert.equal(context.textEdit.draft.stampPattern, stampPattern);
    context.finishTextEdit();
    assert.equal(model.active.strokes[0].text, '123');
    assert.equal(model.active.strokes[0].stampPattern, stampPattern);
    model.undo(); assert.equal(model.active.strokes[0].text, '12');
    model.redo(); assert.equal(model.active.strokes[0].text, '123');
  }
});

test('text and stamp colors stay independent after stamp selection, editing and new text insertion', () => {
  for (const stampPattern of ['plain', 'circle', 'circle-filled', 'square', 'square-filled']) {
    const { context, $, model, original } = setup();
    context.enableSelection(); context.enableTextInsertion();
    $('text-color').value = '#004488'; $('text-color').handlers.change();
    $('stamp-color').value = '#e05267'; $('stamp-size').value = '24'; $('stamp-pattern').value = stampPattern;
    let id = 0;
    Object.assign(context, { uid: () => `stamp-${++id}`, pdfPoint: () => [200, 300] });
    vm.runInContext(slice('function placeNumberStamp(', "\n$('stamp-number').addEventListener"), context);
    context.enableSelection(); context.placeNumberStamp({});
    const stamp = model.active.strokes.at(-1);
    assert.equal(stamp.color, '#e05267');
    context.selectAnnotation(stamp);
    assert.equal($('text-color').value, '#e05267');
    // Returning from a number selection must restore the text insertion color.
    context.enableSelection(); context.enableTextInsertion();
    assert.equal(context.textSettings().color, '#004488');
    context.enableSelection(); context.startTextEdit(stamp);
    context.textEdit.editor.setSelectionRange(0, stamp.text.length);
    $('text-color').value = '#226633'; $('text-color').handlers.change();
    context.finishTextEdit();
    assert.equal(styledRuns(model.active.strokes.at(-1))[0].style.color, '#226633');
    context.enableSelection(); context.enableTextInsertion();
    assert.equal(context.textSettings().color, '#004488');
    assert.equal($('stamp-color').value, '#e05267');
    context.startTextEdit({ ...original, ...context.textSettings(), id: 'new', text: '' }, true);
    context.textEdit.editor.value = 'Separate text color'; context.finishTextEdit();
    assert.equal(model.active.strokes.at(-1).color, '#004488');
    context.enableSelection(); context.placeNumberStamp({});
    assert.equal(model.active.strokes.at(-1).color, '#e05267');
    assert.equal(model.active.strokes[0], original);
  }
});

test('the text icon opens formatting without losing selection or an active draft', () => {
  const { context, model, original } = setup();
  context.togglePreviewMenu('text');
  assert.equal(context.previewMenuOpen, true);
  assert.equal(context.selectedAnnotationId, original.id);
  assert.equal(context.textEnabled, false);
  context.togglePreviewMenu('text');
  assert.equal(context.previewMenuOpen, false);
  context.startTextEdit(original);
  context.textEdit.editor.value = '入力途中'; context.updateTextDraft();
  const editing = context.textEdit;
  const history = model.past.length;
  context.togglePreviewMenu('text');
  assert.equal(context.previewMenuOpen, true);
  assert.equal(context.textEdit, editing);
  assert.equal(context.textEdit.editor.value, '入力途中');
  assert.equal(model.past.length, history);
  context.togglePreviewMenu('pen');
  assert.equal(context.penEnabled, false);
  assert.equal(context.textEdit, editing);
});

test('Escape commits existing and new text edits, retains formatting and focuses the move handle', () => {
  for (const isNew of [false, true]) {
    const { context, $, model, original } = setup();
    const annotation = isNew ? { ...original, id: 'new', text: '' } : original;
    context.startTextEdit(annotation, isNew);
    const editor = context.textEdit.editor;
    editor.value = '編集後の日本語\nPDF';
    editor.setSelectionRange(0, editor.value.length);
    $('text-font').value = 'serif'; $('text-font').handlers.change();
    $('text-bold').handlers.click();
    const handle = $('test-handle'); handle.dataset.annotationId = annotation.id;
    $('text-handles').querySelectorAll = () => [handle];
    let prevented = false, stopped = false;
    editor.handlers.keydown({ key: 'Escape', preventDefault() { prevented = true; },
      stopPropagation() { stopped = true; } });
    assert.equal(prevented && stopped, true);
    assert.equal(context.textEdit, null);
    assert.equal(context.selectedAnnotationId, annotation.id);
    assert.equal(handle.focused, true);
    const committed = model.active.strokes.find(item => item.id === annotation.id);
    assert.equal(committed.text, '編集後の日本語\nPDF');
    assert.ok(styledRuns(committed).every(run => run.style.bold && run.style.fontFamily === 'serif'));
    vm.runInContext([
      slice('function replaceAnnotation(', '\nfunction selectedStroke()'),
      slice('function moveAnnotation(', '\nfunction selectAnnotation('),
      slice('function moveSelectedAnnotation(', '\nfunction positionAnnotationHandle('),
    ].join('\n'), context);
    context.moveSelectedAnnotation(10, 0);
    const moved = model.active.strokes.find(item => item.id === annotation.id);
    assert.equal(moved.text, committed.text); assert.ok(styledRuns(moved).every(run => run.style.bold));
    assert.equal(moved.points[0][0], committed.points[0][0] + 10);
    model.undo(); assert.equal(model.active.strokes.find(item => item.id === annotation.id), committed);
    model.undo(); assert.equal(model.active.strokes.some(item => item.id === annotation.id && item.text === committed.text), false);
    model.redo(); assert.equal(model.active.strokes.find(item => item.id === annotation.id), committed);
  }
});

const key = (value, ctrlKey = false, extra = {}) => ({ key: value, ctrlKey,
  preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });

function multipleSetup(firstSize = 24, secondSize = 36) {
  const env = setup(), { context, model, original } = env;
  original.text = 'Text'; original.fontSize = firstSize;
  const other = { ...original, id: 'other', fontSize: secondSize, color: '#004488', points: [[250, 350]] };
  const unselected = { ...original, id: 'unselected', points: [[60, 600]] };
  model.commit([{ ...model.active, strokes: [original, other, unselected] }, { id: 'other-page', strokes: [original] }]);
  context.selectAnnotation(original); context.selectAnnotation(other, { toggle: true });
  return { ...env, other, unselected };
}

function installHandles({ context, $ }) {
  const handles = [];
  context.document.createElement = () => ({ style: {}, dataset: {}, handlers: {}, attributes: {},
    classList: { toggle(name, value) { this[name] = value; } },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    remove() { handles.splice(handles.indexOf(this), 1); }, focus() {},
    setPointerCapture() { this.captured = true; }, hasPointerCapture() { return !!this.captured; },
    releasePointerCapture() { this.captured = false; },
  });
  $('text-handles').querySelectorAll = () => handles;
  $('text-handles').append = handle => handles.push(handle);
  $('ink-canvas').getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800 });
  vm.runInContext(slice('function refreshAnnotationHandles()', '\nfunction pdfPoint('), context);
  context.refreshAnnotationHandles();
  return handles;
}

const pointer = (x, y, extra = {}) => ({ button: 0, isPrimary: true, pointerId: 1,
  clientX: x, clientY: y, preventDefault() {}, ...extra });

test('text modifier clicks toggle selection, show each selected handle and preserve history', () => {
  for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey']) {
    const env = multipleSetup(), { context, model, original, other } = env;
    context.selectAnnotation(original);
    const handles = installHandles(env), second = handles.find(item => item.dataset.annotationId === other.id);
    const history = model.past.length; model.future.push(model.snapshot());
    second.handlers.pointerdown(pointer(250, 350, { [modifier]: true }));
    assert.equal(context.selectedTexts().length, 2);
    assert.equal(context.textEdit, null); assert.equal(context.annotationDrag, null);
    assert.ok(handles.slice(0, 2).every(item => item.attributes['aria-pressed'] === 'true'));
    assert.equal(handles[2].attributes['aria-pressed'], 'false');
    // Modifier double-clicks must never open an editor.
    second.handlers.dblclick({ [modifier]: true }); assert.equal(context.textEdit, null);
    second.handlers.click({ detail: 0, [modifier]: true });
    assert.equal(context.selectedTexts().length, 1); assert.equal(context.selectedAnnotationId, original.id);
    context.selectAnnotation(original, { toggle: true });
    assert.equal(context.selectedTexts().length, 0); assert.equal(context.selectedAnnotationId, null);
    assert.equal(model.past.length, history); assert.equal(model.future.length, 1);
  }
});

test('group text formatting applies all properties atomically and leaves unselected boxes and pages intact', () => {
  const { context, $, model, original, other, unselected } = multipleSetup();
  const otherPage = model.pages[1], history = model.past.length;
  for (const [id, value, property] of [
    ['text-color', '#cc2200', 'color'], ['text-font', 'serif', 'fontFamily'], ['text-align', 'center', 'textAlign'],
  ]) {
    $(id).value = value; $(id).handlers.input();
    assert.equal(model.past.length, history + ['color', 'fontFamily', 'textAlign'].indexOf(property));
    assert.ok([...context.textFormatSession.previews.values()].every(item => item[property] === value));
    $(id).handlers.change(); $(id).handlers.blur();
    assert.ok(model.active.strokes.slice(0, 2).every(item => item[property] === value));
  }
  for (const style of ['bold', 'italic', 'underline']) $(`text-${style}`).handlers.click();
  assert.ok(model.active.strokes.slice(0, 2).every(item => item.bold && item.italic && item.underline));
  assert.equal(model.active.strokes[2], unselected); assert.equal(model.pages[1], otherPage);
  assert.equal(model.past.length, history + 6);
  for (let index = 0; index < 6; index++) model.undo();
  assert.equal(model.active.strokes[0], original); assert.equal(model.active.strokes[1], other);
  for (let index = 0; index < 6; index++) model.redo();
  context.selectAnnotation(model.active.strokes[1], { preserve: true });
  assert.equal(context.selectedTexts().length, 2);
  assert.equal($('text-bold').getAttribute('aria-pressed'), 'true');
});

test('group size input uses the original baseline, preserves size differences and commits once', () => {
  const { context, $, model } = multipleSetup();
  const history = model.past.length;
  for (const value of ['37', '40']) { $('text-size').value = value; $('text-size').handlers.input(); }
  assert.deepEqual([...context.textFormatSession.previews.values()].map(item => item.fontSize), [28, 40]);
  assert.deepEqual(model.active.strokes.slice(0, 2).map(item => item.fontSize), [24, 36]);
  assert.equal(model.past.length, history);
  $('text-size').handlers.change(); $('text-size').handlers.blur();
  assert.deepEqual(model.active.strokes.slice(0, 2).map(item => item.fontSize), [28, 40]);
  assert.equal(model.past.length, history + 1);
  context.handleTextShortcut(key('ArrowUp', true));
  assert.deepEqual(model.active.strokes.slice(0, 2).map(item => item.fontSize), [29, 41]);
  model.undo(); assert.deepEqual(model.active.strokes.slice(0, 2).map(item => item.fontSize), [28, 40]);
  model.redo(); assert.deepEqual(model.active.strokes.slice(0, 2).map(item => item.fontSize), [29, 41]);
});

test('group size inputs and shortcuts stop at the first limit for either anchor and reverse together', () => {
  for (const firstAnchor of [false, true]) for (const [sizes, input, expected, direction, reverse] of [
    [[24, 36], '96', [84, 96], 'ArrowUp', 'ArrowDown'],
    [[24, 36], '8', [8, 20], 'ArrowDown', 'ArrowUp'],
  ]) {
    const { context, $, model, original, other } = multipleSetup(...sizes);
    context.selectAnnotation(firstAnchor ? original : other, { preserve: true });
    $('text-size').value = input; $('text-size').handlers.input(); $('text-size').handlers.change();
    assert.deepEqual(model.active.strokes.slice(0, 2).map(item => item.fontSize), expected);
    assert.equal(Number($('text-size').value), expected[firstAnchor ? 0 : 1]);
    const history = model.past.length; model.future.push(model.snapshot());
    context.handleTextShortcut(key(direction, true));
    assert.equal(model.past.length, history); assert.equal(model.future.length, 1);
    $('text-size').value = input; $('text-size').handlers.change();
    assert.deepEqual(model.active.strokes.slice(0, 2).map(item => item.fontSize), expected);
    assert.equal(model.past.length, history); assert.equal(model.future.length, 1);
    context.handleTextShortcut(key(reverse, true));
    const step = reverse === 'ArrowUp' ? 1 : -1;
    assert.deepEqual(model.active.strokes.slice(0, 2).map(item => item.fontSize), expected.map(size => size + step));
  }
});

test('partial text sizes constrain the entire group and mixed style buttons toggle the selection consistently', () => {
  const { context, $, model, original, other } = multipleSetup();
  const rich = formatText(original, 1, 3, { fontSize: 95, bold: true });
  model.update(new Set(['page']), page => ({ ...page, strokes: [rich, other, page.strokes[2]] }));
  context.selectAnnotation(other, { preserve: true });
  assert.equal($('text-bold').getAttribute('aria-pressed'), 'mixed');
  context.handleTextShortcut(key('b', true));
  assert.ok(model.active.strokes.slice(0, 2).every(item => styledRuns(item).every(run => run.style.bold)));
  context.handleTextShortcut(key('b', true));
  assert.ok(model.active.strokes.slice(0, 2).every(item => styledRuns(item).every(run => !run.style.bold)));
  $('text-size').value = '60'; $('text-size').handlers.change();
  assert.deepEqual(model.active.strokes.slice(0, 2).map(item => item.fontSize), [25, 37]);
  assert.equal(styledRuns(model.active.strokes[0])[1].style.fontSize, 96);
  const history = model.past.length;
  context.handleTextShortcut(key('ArrowUp', true)); assert.equal(model.past.length, history);
  context.handleTextShortcut(key('ArrowDown', true));
  assert.equal(styledRuns(model.active.strokes[0])[1].style.fontSize, 95);
});

test('returning the size input to its baseline preserves history and partial lower limits stop the whole group', () => {
  const { context, $, model, original, other } = multipleSetup();
  const history = model.past.length; model.future.push(model.snapshot());
  for (const value of ['40', '36']) { $('text-size').value = value; $('text-size').handlers.input(); }
  $('text-size').handlers.change();
  assert.equal(model.past.length, history); assert.equal(model.future.length, 1);
  const rich = formatText(original, 1, 3, { fontSize: 8 });
  model.update(new Set(['page']), page => ({ ...page, strokes: [rich, other] }));
  context.selectAnnotation(other, { preserve: true });
  const boundaryHistory = model.past.length; model.future.push(model.snapshot());
  context.handleTextShortcut(key('ArrowDown', true));
  assert.equal(model.past.length, boundaryHistory); assert.equal(model.future.length, 1);
  assert.equal(model.active.strokes[0], rich); assert.equal(model.active.strokes[1], other);
  context.handleTextShortcut(key('ArrowUp', true));
  assert.deepEqual(styledRuns(model.active.strokes[0]).map(run => run.style.fontSize), [25, 9, 25]);
  assert.equal(model.active.strokes[1].fontSize, 37);
});

test('white and black box backgrounds preview live, keep text styles and create one history entry per gesture', () => {
  for (const color of ['#ffffff', '#000000']) {
    const { context, $, model, original } = setup();
    const rich = formatText(original, 1, 4, { bold: true, fontSize: 30 });
    model.update(new Set(['page']), page => ({ ...page, strokes: [rich] }));
    context.selectAnnotation(rich);
    const history = model.past.length;
    $('text-background').value = color; $('text-background').handlers.input();
    assert.equal(context.annotationFormatPreview.backgroundColor, color);
    assert.equal(model.active.strokes[0], rich);
    $('text-background').handlers.change(); $('text-background').handlers.blur();
    assert.equal(model.active.strokes[0].backgroundColor, color); assert.equal(model.past.length, history + 1);
    for (const value of ['25', '60']) {
      $('text-background-opacity').value = value; $('text-background-opacity').handlers.input();
    }
    assert.equal(context.annotationFormatPreview.backgroundOpacity, 0.6);
    assert.equal($('text-background-opacity-value').value, '60%');
    $('text-background-opacity').handlers.change(); $('text-background-opacity').handlers.blur();
    const changed = model.active.strokes[0];
    assert.equal(changed.backgroundOpacity, 0.6); assert.equal(model.past.length, history + 2);
    assert.deepEqual(changed.runs, rich.runs); assert.equal(changed.color, rich.color);
    model.undo(); assert.equal(textBackground(model.active.strokes[0]).opacity, 1);
    model.redo(); assert.equal(model.active.strokes[0], changed);
    context.handleTextShortcut(key('ArrowUp', true));
    assert.equal(model.active.strokes[0].backgroundColor, color); assert.equal(model.active.strokes[0].backgroundOpacity, 0.6);
  }
});

test('background settings apply to every selected text box and preserve unselected objects and page content', () => {
  const { context, $, model, unselected } = multipleSetup();
  const otherPage = model.pages[1], history = model.past.length;
  $('text-background').value = '#000000'; $('text-background').handlers.change();
  $('text-background-opacity').value = '45'; $('text-background-opacity').handlers.change();
  assert.ok(model.active.strokes.slice(0, 2).every(item => item.backgroundColor === '#000000' && item.backgroundOpacity === 0.45));
  assert.equal(context.selectedTexts().length, 2); assert.equal(model.active.strokes[2], unselected);
  assert.equal(model.pages[1], otherPage); assert.equal(model.past.length, history + 2);
  model.undo(); assert.ok(model.active.strokes.slice(0, 2).every(item => textBackground(item).opacity === 1));
  model.undo(); assert.ok(model.active.strokes.slice(0, 2).every(item => textBackground(item).color === 'none'));
});

test('Ctrl+Left/Right decrease/increase selected text background opacity, update controls and support Undo/Redo', () => {
  for (const color of ['#ffffff', '#000000']) {
    const { context, $, model, original } = setup();
    original.backgroundColor = color; original.backgroundOpacity = 0.7;
    const documentHandlers = {};
    context.document.addEventListener = (type, handler) => { documentHandlers[type] = handler; };
    vm.runInContext(slice("document.addEventListener('keydown', event => {", '\nlet resizeTimer;'), context);
    const history = model.past.length;
    const event = key('ArrowRight', true, { target: { closest: () => null } });
    documentHandlers.keydown(event);
    assert.equal(event.prevented && event.stopped, true);
    const changed = model.active.strokes[0];
    assert.equal(changed.backgroundOpacity, 0.71); assert.equal(changed.backgroundColor, color);
    assert.equal(changed.fontSize, original.fontSize); assert.equal(changed.text, original.text);
    assert.deepEqual(changed.points, original.points); assert.equal(changed.color, original.color);
    assert.equal(Number($('text-background-opacity').value), 71);
    assert.equal($('text-background-opacity-value').value, '71%');
    assert.equal(model.past.length, history + 1);
    model.undo(); assert.equal(model.active.strokes[0], original);
    model.redo(); assert.equal(model.active.strokes[0], changed);
    assert.equal(context.handleTextShortcut(key('ArrowLeft', false, { metaKey: true })), true);
    assert.equal(model.active.strokes[0].backgroundOpacity, 0.7);
  }
});

test('group opacity shortcuts preserve differences, stop at either limit and handle fractional boundaries', () => {
  for (const firstAnchor of [true, false]) {
    const { context, model, original, other, unselected } = multipleSetup();
    original.backgroundColor = '#ffffff'; original.backgroundOpacity = 0.4;
    other.backgroundColor = '#000000'; other.backgroundOpacity = 0.8;
    context.selectAnnotation(firstAnchor ? original : other, { preserve: true });
    const history = model.past.length, otherPage = model.pages[1];
    context.handleTextShortcut(key('ArrowRight', true));
    assert.deepEqual(model.active.strokes.slice(0, 2).map(item => item.backgroundOpacity), [0.41, 0.81]);
    assert.equal(model.past.length, history + 1); assert.equal(context.selectedTexts().length, 2);
    assert.equal(model.active.strokes[2], unselected); assert.equal(model.pages[1], otherPage);
    model.undo(); assert.equal(model.active.strokes[0], original); assert.equal(model.active.strokes[1], other);
    for (const [opacity, direction, reverse] of [[0, 'ArrowLeft', 'ArrowRight'], [1, 'ArrowRight', 'ArrowLeft']]) {
      original.backgroundOpacity = opacity;
      const before = model.past.length; model.future.push(model.snapshot());
      const redo = model.future.length;
      context.handleTextShortcut(key(direction, true));
      assert.equal(model.past.length, before); assert.equal(model.future.length, redo);
      context.handleTextShortcut(key(reverse, true));
      assert.equal(model.past.length, before + 1);
      model.undo();
    }
    original.backgroundOpacity = 0.005; other.backgroundOpacity = 0.7;
    context.handleTextShortcut(key('ArrowLeft', true));
    assert.deepEqual(model.active.strokes.slice(0, 2).map(item => textBackground(item).opacity), [0, 0.695]);
    const before = model.past.length;
    context.handleTextShortcut(key('ArrowLeft', true)); assert.equal(model.past.length, before);
    context.handleTextShortcut(key('ArrowRight', true));
    assert.deepEqual(model.active.strokes.slice(0, 2).map(item => textBackground(item).opacity), [0.01, 0.705]);
  }
});

test('editing opacity shortcuts preserve the caret, draft and text styles and commit once with the text', () => {
  const { context, model, original } = setup();
  original.backgroundColor = '#000000'; original.backgroundOpacity = 0.5;
  const history = model.past.length;
  context.startTextEdit(original);
  const editor = context.textEdit.editor;
  editor.value = '入力中の文字'; editor.setSelectionRange(2, 2);
  for (const repeat of [false, true]) editor.handlers.keydown(key('ArrowRight', true, {
    repeat, target: { closest: () => editor },
  }));
  assert.equal(context.textEdit.draft.text, editor.value);
  assert.equal(context.textEdit.draft.backgroundOpacity, 0.52);
  assert.equal(editor.selectionStart, 2); assert.equal(editor.selectionEnd, 2);
  assert.equal(editor.renderCount || 0, 0); assert.equal(editor.backgroundUpdated, true);
  assert.match(editor.style.backgroundImage, /0 0 0.*0\.52/);
  assert.equal(model.past.length, history);
  context.finishTextEdit(); assert.equal(model.past.length, history + 1);
  assert.equal(model.active.strokes[0].backgroundOpacity, 0.52);
  model.undo(); assert.equal(model.active.strokes[0], original);
});

test('opacity shortcuts ignore backgroundless boxes, other inputs, modifiers, IME, dialogs and active gestures', () => {
  const { context, model, original, $ } = setup();
  const history = model.past.length; model.future.push(model.snapshot());
  assert.equal(context.handleTextShortcut(key('ArrowRight', true)), true);
  assert.equal(model.past.length, history); assert.equal(model.future.length, 1);
  original.backgroundColor = '#ffffff'; original.backgroundOpacity = 0.5;
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }, { shiftKey: true },
    { ctrlKey: false }, { defaultPrevented: true }, { target: { closest: () => ({}) } }]) {
    const event = key('ArrowRight', true, extra);
    assert.equal(context.handleTextShortcut(event), false); assert.equal(event.prevented, undefined);
  }
  for (const guard of ['busy', 'stroke', 'annotationDrag', 'pageDrag']) {
    context[guard] = true;
    assert.equal(context.handleTextShortcut(key('ArrowLeft', true)), false);
    context[guard] = null;
  }
  for (const dialog of ['help-dialog', 'tool-help-dialog', 'save-dialog', 'fullscreen-preview']) {
    $(dialog).open = true;
    assert.equal(context.handleTextShortcut(key('ArrowRight', true)), false);
    $(dialog).open = false;
  }
  assert.equal(model.past.length, history); assert.equal(model.active.strokes[0], original);
  const env = multipleSetup();
  env.other.backgroundColor = '#ffffff'; env.other.backgroundOpacity = 0.5;
  env.context.handleTextShortcut(key('ArrowRight', true));
  assert.equal(env.model.active.strokes[0], env.original);
  assert.equal(env.model.active.strokes[1].backgroundOpacity, 0.51);
});

test('backgrounds change the whole active draft without selecting characters, and cancel or commit with the text', () => {
  const { context, $, model, original } = setup();
  const history = model.past.length;
  context.startTextEdit(original);
  const editor = context.textEdit.editor;
  editor.value = '入力途中の文字'; editor.setSelectionRange(2, 2);
  $('text-background').value = '#ffffff'; $('text-background').handlers.change();
  $('text-background-opacity').value = '35'; $('text-background-opacity').handlers.change();
  assert.equal(context.textEdit.draft.text, editor.value);
  assert.equal(context.textEdit.draft.backgroundOpacity, 0.35);
  assert.match(editor.style.backgroundImage, /255 255 255.*0\.35/);
  assert.equal(editor.backgroundUpdated, true); assert.equal(editor.renderCount || 0, 0);
  assert.equal(editor.selectionStart, 2); assert.equal(editor.selectionEnd, 2);
  assert.equal(model.past.length, history);
  context.finishTextEdit(true); assert.equal(model.active.strokes[0], original);
  context.startTextEdit(original);
  $('text-background').value = '#000000'; $('text-background').handlers.change();
  context.finishTextEdit();
  assert.equal(model.active.strokes[0].backgroundColor, '#000000'); assert.equal(model.past.length, history + 1);
});

test('new text insertion starts with black at zero opacity, retains settings while reopening and preserves existing text', () => {
  const { context, $, model, original } = setup();
  original.backgroundColor = '#ffffff'; original.backgroundOpacity = 0.8;
  context.selectAnnotation(original);
  context.enableSelection(); context.enableTextInsertion();
  assert.equal($('text-background').value, '#000000');
  assert.equal(Number($('text-background-opacity').value), 0);
  assert.equal($('text-background-opacity-value').value, '0%');
  Object.assign(context, { uid: () => 'new-default', pdfPoint: () => [60, 300], fail(error) { throw error; } });
  vm.runInContext(slice("$('ink-canvas').addEventListener('pointerdown', event => {", "\n$('help').addEventListener"), context);
  $('ink-canvas').handlers.pointerdown(pointer(60, 300));
  assert.equal(context.textEdit.draft.backgroundColor, '#000000');
  assert.equal(context.textEdit.draft.backgroundOpacity, 0);
  context.textEdit.editor.value = 'Default background'; context.finishTextEdit();
  assert.equal(model.active.strokes.at(-1).backgroundColor, '#000000');
  assert.equal(model.active.strokes.at(-1).backgroundOpacity, 0);
  context.handleTextShortcut(key('ArrowRight', true));
  assert.equal(model.active.strokes.at(-1).backgroundOpacity, 0.01);
  context.handleTextShortcut(key('ArrowLeft', true));
  assert.equal(model.active.strokes.at(-1).backgroundOpacity, 0);
  assert.equal(model.active.strokes[0], original); assert.equal(original.backgroundOpacity, 0.8);
  context.enableSelection(); context.enableTextInsertion();
  assert.equal(Number($('text-background-opacity').value), 0);
  $('text-background').value = '#ffffff'; $('text-background').handlers.change();
  $('text-background-opacity').value = '65'; $('text-background-opacity').handlers.change();
  context.togglePreviewMenu('text'); context.togglePreviewMenu('text');
  assert.equal($('text-background').value, '#ffffff'); assert.equal(Number($('text-background-opacity').value), 65);
  context.enableSelection(); context.enableTextInsertion();
  assert.equal($('text-background').value, '#000000'); assert.equal(Number($('text-background-opacity').value), 0);
  // Entering insertion via a page switch must not inherit the selected box's background.
  model.commit([...model.pages, { id: 'second-page', strokes: [] }]);
  context.selectAnnotation(original); context.enableTextInsertion();
  context.document.querySelectorAll = () => []; context.renderPreview = () => {};
  vm.runInContext(slice('function activate(', '\nfunction navigatePage('), context);
  context.activate('second-page');
  assert.equal(context.textEnabled, true);
  assert.equal($('text-background').value, '#000000'); assert.equal(Number($('text-background-opacity').value), 0);
});

test('opacity inputs preserve fully transparent backgrounds and removing a background preserves legacy data', () => {
  const { context, $, model, original } = setup();
  const history = model.past.length; model.future.push(model.snapshot());
  $('text-background').value = 'none'; $('text-background').handlers.change();
  assert.equal(model.past.length, history); assert.equal(model.future.length, 1);
  context.enableSelection();
  $('text-background').value = '#ffffff'; $('text-background').handlers.change();
  $('text-background-opacity').value = '0'; $('text-background-opacity').handlers.change();
  const settings = context.textSettings();
  assert.equal(settings.backgroundColor, '#ffffff'); assert.equal(settings.backgroundOpacity, 0);
  assert.equal(model.active.strokes[0], original);
  context.startTextEdit({ ...original, ...settings, id: 'new', text: '' }, true);
  context.textEdit.editor.value = 'New'; context.finishTextEdit();
  assert.equal(model.active.strokes.at(-1).backgroundOpacity, 0);
  $('text-background-opacity').value = '100'; $('text-background-opacity').handlers.change();
  assert.equal(textBackground(model.active.strokes.at(-1)).opacity, 1);
  $('text-background').value = 'none'; $('text-background').handlers.change();
  assert.equal(model.active.strokes.at(-1).backgroundColor, undefined);
});

test('settings tabs commit a pending group background preview and support keyboard navigation without changing selection', () => {
  const { context, $, model } = multipleSetup();
  const history = model.past.length;
  $('text-background').value = '#ffffff'; $('text-background').handlers.input();
  $('text-tab-background').handlers.click();
  assert.equal(model.past.length, history + 1);
  assert.equal($('text-background-settings').hidden, false); assert.equal($('text-character-settings').hidden, true);
  assert.equal($('text-tab-background').getAttribute('aria-selected'), 'true');
  assert.equal($('text-tab-characters').tabIndex, -1); assert.equal(context.selectedTexts().length, 2);
  const event = key('ArrowLeft'); $('text-tab-background').handlers.keydown(event);
  assert.equal(event.prevented && event.stopped, true);
  assert.equal($('text-character-settings').hidden, false); assert.equal($('text-background-settings').hidden, true);
  assert.equal($('text-tab-characters').focused, true); assert.equal(model.past.length, history + 1);
});

test('finishing a text draft commits the group preview before a selection change and individual editing clears the group', () => {
  const { context, $, model, original, other } = multipleSetup();
  const history = model.past.length;
  $('text-color').value = '#cc2200'; $('text-color').handlers.input();
  assert.equal(context.finishTextEdit(), true);
  assert.equal(model.past.length, history + 1);
  assert.ok(model.active.strokes.slice(0, 2).every(item => item.color === '#cc2200'));
  context.selectAnnotation(model.active.strokes[0], { preserve: true });
  assert.equal(context.selectedTexts().length, 2);
  context.startTextEdit(model.active.strokes[0]);
  assert.equal(context.selectedTexts().length, 1); assert.equal(context.selectedTextIds.size, 1);
  context.finishTextEdit(true); context.selectAnnotation(model.active.strokes[1], { toggle: true });
  assert.equal(context.selectedTexts().length, 2);
  const shape = { id: 'shape', tool: 'line', width: 3, color: '#222222', points: [[10, 10], [20, 20]] };
  model.update(new Set(['page']), page => ({ ...page, strokes: [...page.strokes, shape] }));
  context.selectAnnotation(shape, { toggle: true });
  assert.equal(context.selectedTexts().length, 0); assert.equal(context.selectedTextIds.size, 0);
  context.selectAnnotation(model.active.strokes[0], { toggle: true });
  assert.equal(context.selectedStrokes().length, 0); assert.equal(context.selectedStrokeIds.size, 0);
  assert.equal(context.selectedTexts().length, 1);
  assert.equal(original.color, '#222222'); assert.equal(other.color, '#004488');
});

test('a failed fit rolls back the entire formatting preview and preserves Undo and Redo', () => {
  const { context, $, model, original, other } = multipleSetup();
  other.text = 'W'.repeat(10);
  context.selectAnnotation(original, { preserve: true });
  const history = model.past.length; model.future.push(model.snapshot());
  $('text-size').value = '80'; $('text-size').handlers.input(); $('text-size').handlers.change();
  assert.equal(model.active.strokes[0], original); assert.equal(model.active.strokes[1], other);
  assert.equal(model.past.length, history); assert.equal(model.future.length, 1);
  assert.equal(context.textFormatSession, null); assert.equal(context.annotationFormatPreview, null);
  assert.equal(Number($('text-size').value), original.fontSize);
});

test('group text movement, clicks, deletion and deselection preserve the selection and support atomic Undo', () => {
  const env = multipleSetup(), { context, $, model, original, other, unselected } = env;
  const handles = installHandles(env), second = handles.find(item => item.dataset.annotationId === other.id);
  second.handlers.pointerdown(pointer(250, 350)); second.handlers.pointerup(pointer(250, 350));
  assert.equal(context.textEdit, null); assert.equal(context.selectedTexts().length, 2);
  context.handleTextShortcut(key('F2')); assert.equal(context.textEdit, null);
  context.document.querySelectorAll = () => [];
  vm.runInContext(slice('function updateControls()', '\nfunction refresh()'), context);
  context.updateControls();
  assert.equal($('text-menu-title').textContent, '選択したテキスト（2件）');
  assert.equal($('update-text').disabled, true);
  const history = model.past.length;
  second.handlers.pointerdown(pointer(250, 350)); second.handlers.pointermove(pointer(270, 360));
  assert.equal(model.active.strokes[0], original);
  second.handlers.pointerup(pointer(270, 360));
  assert.equal(model.past.length, history + 1);
  assert.deepEqual(model.active.strokes.slice(0, 2).map(item => item.points[0]), [[80, 110], [270, 360]]);
  model.undo(); assert.equal(model.active.strokes[0], original); assert.equal(model.active.strokes[1], other);
  context.moveSelectedAnnotation(10000, 10000);
  const [moved, movedOther] = model.active.strokes;
  assert.ok(Math.abs((movedOther.points[0][0] - moved.points[0][0]) - 190) < 1e-8);
  assert.ok(Math.abs((movedOther.points[0][1] - moved.points[0][1]) - 250) < 1e-8);
  for (const item of [moved, movedOther]) {
    const layout = textLayout($('ink-canvas').getContext('2d'), item, context.viewport);
    assert.ok(layout.right <= 600 + 1e-8 && layout.bottom <= 800 + 1e-8);
  }
  model.undo();
  context.refresh = () => context.updateControls();
  vm.runInContext(slice('function deleteSelectedAnnotation()', "\non('delete-text'"), context);
  context.deleteSelectedAnnotation(); assert.deepEqual(model.active.strokes, [unselected]);
  model.undo(); assert.equal(model.active.strokes[0], original); assert.equal(model.active.strokes[1], other);
  context.selectAnnotation(original); context.selectAnnotation(other, { toggle: true });
  context.enableSelection(); assert.equal(context.selectedTextIds.size, 0);
  context.selectAnnotation(original); context.handleTextShortcut(key('ArrowUp', true));
  assert.equal(model.active.strokes[1], other);
});

test('F2 edits selected text; shortcuts affect only selected characters and survive Escape and re-editing', () => {
  const { context, model, original } = setup();
  assert.equal(context.handleTextShortcut(key('F2')), true);
  const editor = context.textEdit.editor;
  editor.setSelectionRange(1, 4);
  for (const value of ['b', 'i', 'u', 'ArrowUp']) {
    const event = key(value, true); editor.handlers.keydown(event);
    assert.equal(event.prevented && event.stopped, true);
  }
  const runs = styledRuns(context.textEdit.draft);
  assert.equal(runs[0].style.bold, false);
  assert.ok(runs.filter(run => run.start < 4 && run.end > 1).every(run =>
    run.style.bold && run.style.italic && run.style.underline && run.style.fontSize === 25));
  assert.equal(runs.at(-1).style.fontSize, 24);
  editor.handlers.keydown(key('Escape'));
  assert.equal(context.textEdit, null);
  const committed = model.active.strokes[0];
  assert.equal(committed.text, original.text); assert.ok(committed.runs.length);
  context.handleTextShortcut(key('F2'));
  assert.deepEqual(context.textEdit.draft.runs, committed.runs);
});

test('selection-mode shortcuts format the whole box and each action supports Undo/Redo', () => {
  const { context, model, original } = setup();
  for (const value of ['b', 'i', 'u', 'ArrowDown']) assert.equal(context.handleTextShortcut(key(value, true)), true);
  const committed = model.active.strokes[0];
  assert.ok(styledRuns(committed).every(run => run.style.bold && run.style.italic && run.style.underline && run.style.fontSize === 23));
  assert.equal(context.textEdit, null);
  model.undo(); assert.equal(model.active.strokes[0].fontSize, original.fontSize);
  model.redo(); assert.equal(model.active.strokes[0], committed);
});

test('shortcut guards preserve caret-only edits, IME, other inputs and size limits', () => {
  const { context, original } = setup();
  context.startTextEdit(original);
  const editor = context.textEdit.editor;
  editor.setSelectionRange(2, 2);
  const before = JSON.stringify(context.textEdit.draft);
  editor.handlers.keydown(key('b', true));
  assert.equal(JSON.stringify(context.textEdit.draft), before);
  editor.setSelectionRange(0, original.text.length);
  assert.equal(context.handleTextShortcut(key('b', true, { isComposing: true })), false);
  assert.equal(context.handleTextShortcut(key('b', true, { target: { closest: () => ({}) } })), false);
  context.textEdit.draft = formatText(original, 0, original.text.length, { fontSize: 96 }, true);
  context.handleTextShortcut(key('ArrowUp', true));
  assert.ok(styledRuns(context.textEdit.draft).every(run => run.style.fontSize === 96));
  context.textEdit.draft = formatText(original, 0, original.text.length, { fontSize: 8 }, true);
  context.handleTextShortcut(key('ArrowDown', true));
  assert.ok(styledRuns(context.textEdit.draft).every(run => run.style.fontSize === 8));
});

test('selected-range size reduction can recover text that is too large for the paper', () => {
  const { context, $, original } = setup();
  context.startTextEdit(original);
  const editor = context.textEdit.editor;
  editor.value = 'W'.repeat(45); editor.setSelectionRange(0, editor.value.length);
  assert.equal(context.updateTextDraft(), false);
  $('text-size').value = '8'; $('text-size').handlers.change();
  assert.equal(context.textEdit.draft.text, editor.value);
  assert.ok(styledRuns(context.textEdit.draft).every(run => run.style.fontSize === 8));
  assert.equal(context.finishTextEdit(), true);
});

test('text selection and editing disable other toolbar tools, and deselection restores them', () => {
  const { context, $, original } = setup();
  context.document.querySelectorAll = selector => selector === 'button, input, select, textarea'
    ? ['select', 'pen', 'text', 'rotation', 'watermark'].map(name => $(`open-${name}`)) : [];
  vm.runInContext(slice('function updateControls()', '\nfunction refresh()'), context);
  const assertTools = locked => {
    context.updateControls();
    for (const name of ['select', 'pen', 'rotation', 'watermark']) assert.equal($(`open-${name}`).disabled, locked);
    assert.equal($('open-text').disabled, false);
  };
  assertTools(true);
  assert.equal($('panel-text').hidden, true);
  context.startTextEdit(original); assertTools(true);
  context.togglePreviewMenu('text'); assertTools(true);
  assert.equal($('panel-text').hidden, false);
  assert.equal(context.textEdit.original, original);
  context.finishTextEdit(); assertTools(true);
  assert.equal($('panel-text').hidden, true);
  context.selectedAnnotationId = null; assertTools(false);
  // A new, empty box has no stored annotation yet, but still locks other tools.
  context.startTextEdit({ ...original, id: 'new', text: '' }, true); assertTools(true);
  context.finishTextEdit(true); assertTools(false);
});

test('selected text formatting updates immediately, restores through history and returns to defaults', () => {
  const { context, $, model, original } = setup();
  // Opening and confirming legacy text must not create an Undo entry.
  const history = model.past.length;
  context.previewTextFormatting(); context.finishAnnotationFormatting();
  assert.equal(model.past.length, history);
  $('text-font').value = 'serif'; $('text-font').handlers.change();
  $('text-align').value = 'right'; $('text-align').handlers.change();
  for (const style of ['bold', 'italic', 'underline']) $(`text-${style}`).handlers.click();
  const formatted = model.active.strokes[0];
  assert.equal(formatted.fontFamily, 'serif'); assert.equal(formatted.textAlign, 'right');
  for (const style of ['bold', 'italic', 'underline']) assert.equal(formatted[style], true);
  assert.equal(original.fontFamily, undefined);
  model.undo(); context.selectAnnotation(model.active.strokes[0]);
  assert.equal($('text-underline').getAttribute('aria-pressed'), 'false');
  model.redo(); context.selectAnnotation(model.active.strokes[0]);
  assert.equal($('text-underline').getAttribute('aria-pressed'), 'true');
  $('text-font').value = 'sans-serif'; $('text-font').handlers.change();
  $('text-align').value = 'left'; $('text-align').handlers.change();
  for (const style of ['bold', 'italic', 'underline']) $(`text-${style}`).handlers.click();
  assert.equal(JSON.stringify(model.active.strokes[0]), JSON.stringify(original));
});

test('formatting an active editor preserves multiline text, commits once and cancels together', () => {
  const { context, $, model, original, errors } = setup();
  const history = model.past.length;
  context.startTextEdit(original);
  context.textEdit.editor.value = '日本語\nPDF';
  context.textEdit.editor.setSelectionRange(0, context.textEdit.editor.value.length);
  $('text-font').value = 'monospace'; $('text-font').handlers.change();
  $('text-align').value = 'center'; $('text-align').handlers.change();
  for (const style of ['bold', 'italic', 'underline']) $(`text-${style}`).handlers.click();
  const { editor } = context.textEdit;
  assert.ok(styledRuns(context.textEdit.draft).every(run => run.style.fontFamily === 'monospace'
    && run.style.bold && run.style.italic && run.style.underline && run.style.textAlign === 'center'));
  assert.equal(model.past.length, history);
  assert.equal(context.finishTextEdit(), true);
  assert.equal(model.past.length, history + 1);
  const committed = model.active.strokes[0];
  assert.equal(committed.text, '日本語\nPDF'); assert.ok(styledRuns(committed).every(run => run.style.underline));
  context.startTextEdit(committed);
  context.textEdit.editor.setSelectionRange(0, committed.text.length);
  $('text-bold').handlers.click();
  assert.equal(context.finishTextEdit(true), true);
  assert.equal(model.active.strokes[0], committed);
  model.undo(); assert.equal(model.active.strokes[0], original);
  model.redo(); assert.equal(model.active.strokes[0], committed);
  assert.deepEqual(errors, []);
});

test('formatted text measures its font and aligns shorter lines within the longest line', () => {
  const { context, original } = setup();
  const ctx = createCanvas(600, 800).getContext('2d');
  for (const fontFamily of ['sans-serif', 'serif', 'monospace']) {
    for (const [textAlign, factor] of [['left', 0], ['center', 0.5], ['right', 1]]) {
      const annotation = { ...original, fontFamily, textAlign, bold: true, italic: true };
      const layout = textLayout(ctx, annotation, context.viewport);
      ctx.font = textFont(24, annotation);
      assert.ok(Math.abs(layout.lineWidths[0] - ctx.measureText('Long line').width) < 0.01);
      assert.ok(Math.abs(layout.lineOffsets[1] - layout.insetLeft -
        (layout.contentWidth - layout.lineWidths[1]) * factor) < 1e-8);
      const moved = moveText(ctx, annotation, context.viewport, 10000, 10000);
      const bounds = textLayout(ctx, moved, context.viewport);
      assert.ok(bounds.right <= 600 + 1e-8 && bounds.bottom <= 800 + 1e-8);
    }
  }
});

test('underlines follow each line width and alignment, skipping blank lines', () => {
  const { context, original } = setup();
  const canvas = createCanvas(600, 800), ctx = canvas.getContext('2d');
  const annotation = { ...original, text: 'Long line\n\nPDF', underline: true, textAlign: 'right' };
  paintOverlay(ctx, { strokes: [annotation] }, context.viewport);
  const layout = textLayout(ctx, annotation, context.viewport);
  const alpha = (x, y) => ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3];
  for (const index of [0, 2]) {
    const x = layout.x + layout.lineOffsets[index];
    const y = layout.y + index * 24 * 1.3 + 24 * 1.05;
    assert.ok(alpha(x + layout.lineWidths[index] / 2, y) > 0);
    assert.equal(alpha(x + layout.lineWidths[index] + 3, y), 0);
    if (index === 2) assert.equal(alpha(layout.x + 2, y), 0);
  }
  assert.equal(alpha(layout.x + layout.width / 2, layout.y + 24 * 1.3 + 24 * 1.05), 0);
});
