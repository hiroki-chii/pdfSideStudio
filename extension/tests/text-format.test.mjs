import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createCanvas } from '@napi-rs/canvas';
import { EditorModel } from '../src/model.js';
import { textFont, textFontFamily, textLayout, moveText, paintOverlay } from '../src/pdf.js';
import { styledRuns, textStyle, formatText, replaceText } from '../src/text-format.js';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const slice = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));
const script = [
  slice('function selectedText()', '\nfunction selectedAnnotation()'),
  slice('function selectAnnotation(', '\nfunction enableTextInsertion()'),
  slice('function enableTextInsertion()', "\n$('open-text').addEventListener"),
  slice('function togglePreviewMenu(', "\n$('open-select').addEventListener"),
  slice('function focusSelectedAnnotation()', "\n$('update-text').addEventListener"),
  slice('function positionTextEditor()', '\n// Commit before toolbar/page/export'),
  slice('function textFormatRange()', '\nfunction deleteSelectedAnnotation()'),
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
  const context = vm.createContext({ $, model, viewport, textLayout, moveText, textFontFamily,
    styledRuns, textStyle, formatText, replaceText,
    createTextEditor(annotation) {
      const editor = node(); editor.value = annotation.text;
      editor.getAnnotation = () => replaceText(context.textEdit?.draft || annotation, editor.value);
      editor.setAnnotation = value => { editor.value = value.text; };
      return editor;
    },
    busy: false, selectedAnnotationId: 'text', textFormatPreview: null, textEdit: null,
    textEnabled: false, penEnabled: false, activePreviewMenu: 'text',
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
  context.previewTextFormatting(); context.finishTextFormatting();
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
