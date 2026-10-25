import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const dismissalScript = app.slice(app.indexOf("document.addEventListener('pointerdown', event => {"),
  app.indexOf('\nfunction textFormatRange()'));
const drawingScript = app.slice(app.indexOf("$('ink-canvas').addEventListener('pointerdown', event => {"),
  app.indexOf("\n$('help').addEventListener"));

function setup(tool) {
  const nodes = new Map();
  const documentHandlers = {};
  const calls = [];
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: id !== `panel-${tool}`, value: 'pen', handlers: {},
      addEventListener(type, handler) { this.handlers[type] = handler; },
      setPointerCapture() { calls.push('capture'); },
      getContext() { return {}; },
    });
    return nodes.get(id);
  };
  const context = vm.createContext({ $, document: {
    addEventListener(type, handler, capture) { documentHandlers[type] = { handler, capture }; },
  }, previewMenuOpen: true, penEnabled: tool === 'pen', textEnabled: tool === 'text',
  busy: false, stroke: null, annotationDrag: null, pageDrag: null, selectedAnnotationId: null, selectedStrokeIds: new Set(), selectedTextIds: new Set(),
  activePreviewMenu: tool, textEdit: null, viewport: {},
  model: { activeId: 'page', active: { rotation: 0, strokes: [] },
    update() { calls.push('save-stroke'); } },
  updateControls() {
    if (!context.previewMenuOpen) { $('panel-pen').hidden = true; $('panel-text').hidden = true; }
  },
  finishAnnotationFormatting() { calls.push('format'); },
  finishTextEdit() { calls.push('commit-text'); return true; },
  refreshAnnotationHandles() {}, refreshThumbnails() {}, status() {},
  enableSelection() { calls.push('select'); }, uid: () => 'annotation',
  textSettings: () => ({}), pdfPoint: event => [event.clientX, event.clientY],
  startTextEdit() { calls.push('place-text'); },
  paintOverlay() { calls.push('paint'); }, fail(error) { throw error; },
  });
  vm.runInContext(dismissalScript + '\n' + drawingScript, context);
  function pointerdown({ target = 'canvas', ...overrides } = {}) {
    const event = { button: 0, isPrimary: true, pointerId: 1, clientX: 20, clientY: 30,
      target: { closest(selector) {
        if (selector.startsWith('.canvas-stack,') && ['canvas', 'handle', 'editor', 'settings', 'button', 'dialog', 'label'].includes(target)) return {};
        if (selector === '#preview-scroll' && ['canvas', 'handle', 'blank', 'editor'].includes(target)) return {};
        if (selector === '.text-editor' && target === 'editor') return {};
        if (selector === '.text-settings' && target === 'settings') return {};
        return null;
      } },
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...overrides };
    assert.equal(documentHandlers.pointerdown.capture, true);
    documentHandlers.pointerdown.handler(event);
    if (!event.stopped && target === 'canvas') $('ink-canvas').handlers.pointerdown(event);
    return event;
  }
  return { context, $, calls, pointerdown };
}

function selectedSetup(tool) {
  const env = setup(tool);
  const { context, calls } = env;
  context.selectedAnnotationId = 'annotation';
  context.resetPreviewMenu = () => { context.activePreviewMenu = 'select'; };
  context.finishTextEdit = () => {
    if (context.textEdit) {
      calls.push('commit-text');
      if (context.invalidText) return false;
      context.textEdit = null;
    }
    return true;
  };
  vm.runInContext(app.slice(app.indexOf('function enableSelection('), app.indexOf('\nfunction togglePreviewMenu(')), context);
  return env;
}

for (const tool of ['text', 'pen']) {
  test(`${tool}: outside-paper blank clicks clear selection and close settings in one gesture`, () => {
    for (const target of ['blank', 'outside']) for (const menuOpen of [false, true]) {
      const { context, pointerdown } = selectedSetup(tool);
      context.previewMenuOpen = menuOpen;
      const event = pointerdown({ target });
      assert.equal(context.selectedAnnotationId, null);
      assert.equal(context.previewMenuOpen, false);
      assert.equal(context.activePreviewMenu, 'select');
      assert.equal(event.stopped, undefined);
    }
  });
}

test('outside blank clicks commit active text before deselecting, but preserve invalid text', () => {
  for (const invalidText of [false, true]) {
    const { context, calls, pointerdown } = selectedSetup('text');
    const editor = {};
    context.textEdit = { editor }; context.invalidText = invalidText;
    const event = pointerdown({ target: 'outside' });
    assert.deepEqual(calls, ['format', 'commit-text']);
    assert.equal(context.selectedAnnotationId, invalidText ? 'annotation' : null);
    assert.equal(!!context.textEdit, invalidText);
    assert.equal(event.stopped, invalidText ? true : undefined);
  }
});

test('settings, controls, object clicks and non-editing gestures do not clear selection', () => {
  for (const options of [{ target: 'settings' }, { target: 'button' }, { target: 'dialog' }, { target: 'label' },
    { target: 'handle' }, { target: 'editor' }, { target: 'outside', button: 2 }, { target: 'outside', isPrimary: false }]) {
    const { context, pointerdown } = selectedSetup('text');
    pointerdown(options);
    assert.equal(context.selectedAnnotationId, 'annotation');
  }
  for (const guard of ['busy', 'stroke', 'annotationDrag', 'pageDrag']) {
    const { context, pointerdown } = selectedSetup('pen');
    context[guard] = true;
    pointerdown({ target: 'outside' });
    assert.equal(context.selectedAnnotationId, 'annotation');
  }
});

for (const tool of ['pen', 'text']) {
  test(`${tool}: first preview gesture only closes the menu; next gesture edits`, () => {
    const { context, $, calls, pointerdown } = setup(tool);
    const first = pointerdown();
    assert.equal(context.previewMenuOpen, false);
    assert.equal($(`panel-${tool}`).hidden, true);
    assert.equal(first.defaultPrevented, true);
    assert.equal(first.stopped, true);
    assert.equal(context.stroke, null);
    assert.deepEqual(calls, []);
    // Dragging and releasing the dismissal gesture must not save a dot or line.
    $('ink-canvas').handlers.pointermove(first);
    $('ink-canvas').handlers.pointerup({ ...first, type: 'pointerup' });
    assert.deepEqual(calls, []);
    pointerdown();
    if (tool === 'pen') {
      assert.equal(context.stroke.id, 'annotation');
      assert.ok(calls.includes('capture'));
    } else assert.ok(calls.includes('place-text'));
  });

  test(`${tool}: clicking existing annotations or preview margins only dismisses`, () => {
    for (const target of ['handle', 'blank']) {
      const { context, calls, pointerdown } = setup(tool);
      assert.equal(pointerdown({ target }).stopped, true);
      assert.equal(context.previewMenuOpen, false);
      assert.deepEqual(calls, []);
    }
  });
}

test('menu controls, active text editor and non-primary pointers do not trigger dismissal', () => {
  for (const options of [{ target: 'settings' }, { target: 'editor' }, { button: 2 }, { isPrimary: false }]) {
    const { context, pointerdown } = setup('text');
    assert.equal(pointerdown(options).stopped, undefined);
    assert.equal(context.previewMenuOpen, true);
  }
});

test('other menus retain outside-click dismissal', () => {
  const { context, pointerdown } = setup('rotation');
  assert.equal(pointerdown().stopped, undefined);
  assert.equal(context.previewMenuOpen, true);
});
