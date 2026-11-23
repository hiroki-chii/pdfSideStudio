import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const menuNames = ['rotation', 'pen', 'stamp', 'watermark', 'text'];
const toggleScript = app.slice(app.indexOf('function togglePreviewMenu('),
  app.indexOf('\nfunction openPreviewMenu('));
const closeButtonScript = app.slice(app.indexOf("for (const button of document.querySelectorAll('[data-close-preview-menu]'))"),
  app.indexOf("\n$('start-pen').addEventListener"));
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
      focus() { calls.push(`focus:${id}`); },
      setPointerCapture() { calls.push('capture'); },
      getContext() { return {}; },
    });
    return nodes.get(id);
  };
  const context = vm.createContext({ $, document: {
    addEventListener(type, handler, capture) { documentHandlers[type] = { handler, capture }; },
  }, editorTab: true, previewMenuOpen: true, penEnabled: tool === 'pen', textEnabled: tool === 'text',
  busy: false, stroke: null, annotationDrag: null, pageDrag: null, selectedAnnotationId: null, selectedStrokeIds: new Set(), selectedTextIds: new Set(),
  activePreviewMenu: tool, textEdit: null, viewport: {}, renderedPageId: 'page',
  model: { activeId: 'page', active: { rotation: 0, strokes: [] },
    update() { calls.push('save-stroke'); } },
  updateControls() {
    if (!context.previewMenuOpen) {
      for (const name of menuNames) $(`panel-${name}`).hidden = true;
    }
  },
  finishAnnotationFormatting() { calls.push('format'); },
  finishTextEdit() { calls.push('commit-text'); return true; },
  refreshAnnotationHandles() {}, refreshThumbnails() {}, status() {},
  enableSelection() { calls.push('select'); }, uid: () => 'annotation',
  textSettings: () => ({}), pdfPoint: event => [event.clientX, event.clientY],
  startTextEdit() { calls.push('place-text'); },
  placeNumberStamp() { calls.push('place-stamp'); },
  paintOverlay() { calls.push('paint'); }, fail(error) { throw error; },
  });
  vm.runInContext(dismissalScript + '\n' + drawingScript, context);
  function pointerdown({ target = 'canvas', ...overrides } = {}) {
    const event = { button: 0, isPrimary: true, pointerId: 1, clientX: 20, clientY: 30,
      target: { closest(selector) {
        if (selector === '[data-tool-help], #tool-help-dialog' && ['tool-help', 'tool-help-dialog'].includes(target)) return {};
        if (selector.startsWith('.canvas-stack,') && ['canvas', 'handle', 'editor', 'settings', 'button', 'dialog', 'label', 'close-menu'].includes(target)) return {};
        if (selector.includes('[data-close-preview-menu]') && target === 'close-menu') return {};
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

function setupCloseButton(tool) {
  const env = setup(tool);
  const { context, $ } = env;
  const panel = html.match(new RegExp(`<section id="panel-${tool}"[^>]*>([\\s\\S]*?)</section>`))?.[1];
  assert.ok(panel?.includes(`data-close-preview-menu="${tool}" aria-label="メニューを閉じる">閉じる</button>`));
  const button = $(`close-menu-${tool}`);
  button.dataset = { closePreviewMenu: tool };
  context.document.querySelectorAll = () => [button];
  context.selectedText = () => null;
  context.selectedStroke = () => null;
  vm.runInContext(toggleScript + '\n' + closeButtonScript, context);
  return { ...env, button };
}

test('menu close buttons hide their menu and return focus to its tool', () => {
  for (const tool of menuNames) {
    const { context, $, calls, button } = setupCloseButton(tool);
    button.handlers.click();
    assert.equal($(`panel-${tool}`).hidden, true);
    assert.equal(context.activePreviewMenu, tool);
    assert.deepEqual(calls, [`focus:open-${tool}`]);
  }
});

test('closing text settings by pointer keeps the draft and its selection', () => {
  const { context, calls, pointerdown, button } = setupCloseButton('text');
  const draft = { editor: {} };
  context.textEdit = draft;
  context.selectedAnnotationId = 'text';
  pointerdown({ target: 'close-menu' });
  button.handlers.click();
  assert.equal(context.previewMenuOpen, false);
  assert.equal(context.textEdit, draft);
  assert.equal(context.selectedAnnotationId, 'text');
  assert.deepEqual(calls, ['format', 'focus:open-text']);
});

test('tab editor lets the first paper gesture edit with the sidebar settings open', () => {
  const { context, pointerdown, calls } = setup('stamp');
  context.editorTab = true;
  const event = pointerdown();
  assert.equal(event.stopped, undefined);
  assert.equal(context.previewMenuOpen, true);
  assert.ok(calls.includes('place-stamp'));
});

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

test('the toolbar omits selection and empty paper exits settings-only tools', () => {
  assert.doesNotMatch(html, /id="(?:open-select|panel-select)"/);
  for (const tool of ['rotation', 'watermark', 'image']) {
    const { context, pointerdown } = selectedSetup(tool);
    context.selectedAnnotationId = null;
    pointerdown();
    assert.equal(context.activePreviewMenu, 'select');
    assert.equal(context.previewMenuOpen, false);
  }
});

test('blank space outside the paper exits placement modes while paper clicks place objects', () => {
  for (const tool of ['text', 'stamp']) for (const target of ['blank', 'outside']) {
    const { context, calls, pointerdown } = selectedSetup(tool);
    context.selectedAnnotationId = null;
    pointerdown();
    assert.ok(calls.includes(`place-${tool}`));
    assert.equal(context.activePreviewMenu, tool);
    pointerdown({ target: 'settings' });
    assert.equal(context.activePreviewMenu, tool);
    pointerdown({ target });
    assert.equal(context.activePreviewMenu, 'select');
    assert.equal(context.textEnabled, false);
    assert.equal(context.previewMenuOpen, false);
    assert.equal(calls.filter(call => call === `place-${tool}`).length, 1);
  }
});

test('a pen click exits drawing without a stroke and a drag continues drawing', () => {
  const { context, $, calls, pointerdown } = selectedSetup('pen');
  context.selectedAnnotationId = null;
  const handlers = $('ink-canvas').handlers;
  const drag = pointerdown();
  handlers.pointermove({ ...drag, clientX: 40 });
  handlers.pointerup({ ...drag, type: 'pointerup' });
  assert.equal(context.penEnabled, true);
  assert.equal(calls.filter(call => call === 'save-stroke').length, 1);

  const click = pointerdown();
  handlers.pointerup({ ...click, type: 'pointerup', clientX: click.clientX + 1 });
  assert.equal(context.penEnabled, false);
  assert.equal(context.activePreviewMenu, 'select');
  assert.equal(context.previewMenuOpen, false);
  assert.equal(calls.filter(call => call === 'save-stroke').length, 1);
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

for (const tool of ['pen', 'text', 'stamp']) {
  test(`${tool}: side panel paper gestures cannot edit even if an old tool mode remains`, () => {
    const { context, $, calls, pointerdown } = setup(tool);
    context.editorTab = false;
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
    assert.equal(context.stroke, null);
    assert.equal(calls.includes('capture'), false);
    assert.equal(calls.includes('place-stamp'), false);
    assert.equal(calls.includes('place-text'), false);
  });

  test(`${tool}: clicking existing annotations or preview margins only dismisses`, () => {
    for (const target of ['handle', 'blank']) {
      const { context, calls, pointerdown } = setup(tool);
      context.editorTab = false;
      assert.equal(pointerdown({ target }).stopped, true);
      assert.equal(context.previewMenuOpen, false);
      assert.deepEqual(calls, []);
    }
  });
}

test('menu controls, active text editor and non-primary pointers do not trigger dismissal', () => {
  for (const tool of ['pen', 'text', 'stamp']) for (const options of [
    { target: 'settings' }, { target: 'editor' }, { button: 2 }, { isPrimary: false },
  ]) {
    const { context, pointerdown } = setup(tool);
    assert.equal(pointerdown(options).stopped, undefined);
    assert.equal(context.previewMenuOpen, true);
  }
});

test('other menus retain outside-click dismissal', () => {
  const { context, pointerdown } = setup('rotation');
  assert.equal(pointerdown().stopped, undefined);
  assert.equal(context.previewMenuOpen, true);
});

test('tool help controls preserve an active text draft, selection and menu', () => {
  for (const target of ['tool-help', 'tool-help-dialog']) {
    const { context, calls, pointerdown } = setup('text');
    const draft = { editor: {} };
    context.textEdit = draft;
    context.selectedAnnotationId = 'text';
    pointerdown({ target });
    assert.equal(context.textEdit, draft);
    assert.equal(context.selectedAnnotationId, 'text');
    assert.equal(context.previewMenuOpen, true);
    assert.deepEqual(calls, []);
  }
});
