import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { EditorModel, normalizeRotation } from '../src/model.js';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const slice = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));

function setup(editorTab = false) {
  const nodes = new Map(), focused = [], errors = [];
  const matches = (node, selector) => selector.startsWith('.')
    ? node.className.split(' ').includes(selector.slice(1)) : node.tag === selector;
  const element = tag => {
    const node = { tag, className: '', children: [], dataset: {}, attributes: {}, handlers: {},
      style: { setProperty() {} },
      append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      querySelectorAll(selector) {
        const result = [];
        for (const child of this.children) {
          if (selector.split(', ').some(part => matches(child, part))) result.push(child);
          result.push(...child.querySelectorAll(selector));
        }
        return result;
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0]; },
      closest(selector) { return matches(this, selector) ? this : this.parent?.closest(selector); },
      setPointerCapture(id) { this.pointerId = id; },
      hasPointerCapture(id) { return this.pointerId === id; },
      releasePointerCapture() { this.pointerId = null; },
      focus() { focused.push(this.dataset.id ?? this.id); }, scrollIntoView() {},
      getBoundingClientRect() {
        if (this.id === 'page-list') return { left: 0, top: 0, right: 300, bottom: 300, width: 300, height: 300 };
        const card = this.closest('.page-card');
        const index = $('page-list').children.indexOf(card);
        const left = editorTab ? 0 : index * 100, top = editorTab ? index * 100 : 0;
        return { left, top, right: left + 100, bottom: top + 100, width: 100, height: 100 };
      },
    };
    node.classList = {
      add(name) { if (!matches(node, `.${name}`)) node.className += ` ${name}`; },
      remove(name) { node.className = node.className.split(' ').filter(item => item !== name).join(' '); },
    };
    return node;
  };
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { ...element('div'), id });
    return nodes.get(id);
  };
  const model = new EditorModel();
  model.commit(['a', 'b', 'c'].map((id, index) => ({ id, sourceId: 'pdf', index,
    rotation: index * 90, strokes: [{ id: `note-${id}`, tool: 'text', text: id }], watermark: { text: id } })));
  let sequence = 0;
  const context = vm.createContext({ $, model, editorTab, normalizeRotation,
    sources: new Map([['pdf', { name: 'sample.pdf', number: 1, color: 'red' }]]),
    document: { createElement: element, body: element('body') },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    observer: null, thumbQueue: [], busy: false, stroke: null, annotationDrag: null,
    pageDrag: null, draggedPageId: null, dragPointer: null, dragScrollFrame: null,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    uid: () => `copy-${++sequence}`, penEnabled: false, textEnabled: false,
    resetPreviewMenu() {}, finishTextEdit: () => true,
    setBusy(value) { context.busy = value; }, fail(error) { errors.push(error); },
    status() {}, selectPage(id) { model.activeId = id; },
    refresh() { context.refreshThumbnails(); },
  });
  vm.runInContext([
    slice('async function run(', '\nfunction activeRequired('),
    slice('function refreshThumbnails()', '\nasync function pumpThumbnails('),
    slice('function duplicatePage(', "\non('undo'"),
    slice('function pageActionRequired(', '\nfunction selectPage('),
  ].join('\n'), context);
  context.refresh();
  const card = id => $('page-list').children.find(card => card.querySelector('.page-button').dataset.id === id);
  const action = (id, title) => card(id).querySelectorAll('.page-card-action').find(button => button.title === title);
  const click = async (id, title, detail = 1) => {
    await action(id, title).handlers.click({ detail });
    assert.deepEqual(errors, []);
  };
  return { $, model, context, card, action, click, focused };
}

for (const editorTab of [false, true]) {
  test(`${editorTab ? 'tab' : 'side panel'}: thumbnail copy, delete and rotation preserve other pages and support Undo`, async () => {
    const { model, click } = setup(editorTab);
    const original = model.pages[1];
    await click('b', 'コピー');
    assert.deepEqual(model.pages.map(page => page.id), ['a', 'b', 'copy-1', 'c']);
    assert.equal(model.activeId, 'copy-1');
    assert.equal(model.active.strokes, original.strokes);
    await click('b', '削除');
    assert.deepEqual(model.pages.map(page => page.id), ['a', 'copy-1', 'c']);
    model.undo(); assert.equal(model.pages[1], original);
    model.redo(); assert.equal(model.pages.some(page => page.id === 'b'), false);
  });

  test(`${editorTab ? 'tab' : 'side panel'}: list rotation affects only the clicked page, regardless of preview scope`, async () => {
    const { $, model, click, focused } = setup(editorTab);
    $('rotation-scope').value = 'all';
    const before = model.pages;
    await click('b', '右に90°回転', 0);
    assert.equal(model.activeId, 'a');
    assert.equal(focused.at(-1), 'b');
    assert.deepEqual(model.pages.map(page => page.rotation), [0, 180, 180]);
    assert.equal(model.pages[0], before[0]); assert.equal(model.pages[2], before[2]);
    assert.equal(model.pages[1].strokes, before[1].strokes);
    assert.equal(model.pages[1].watermark, before[1].watermark);
    assert.equal($('rotation-scope').value, 'all');
    model.undo(); assert.equal(model.pages[1], before[1]);
    model.redo(); assert.equal(model.pages[1].rotation, 180);
    await click('a', '左に90°回転');
    assert.equal(model.active.rotation, 270);
  });

  test(`${editorTab ? 'tab' : 'side panel'}: thumbnails reorder with pointer dragging and preserve the active page`, async () => {
    const { model, context, card } = setup(editorTab);
    const button = card('a').querySelector('.page-button');
    const start = { button: 0, isPrimary: true, pointerId: 1, clientX: 10, clientY: 10 };
    button.handlers.pointerdown(start);
    assert.equal(context.pageDrag.id, 'a');
    const end = { ...start, clientX: editorTab ? 10 : 280, clientY: editorTab ? 280 : 10 };
    button.handlers.pointermove(end);
    assert.equal(context.draggedPageId, 'a');
    button.handlers.pointerup(end);
    await new Promise(setImmediate);
    assert.deepEqual(model.pages.map(page => page.id), ['b', 'c', 'a']);
    assert.equal(model.activeId, 'a');
    model.undo(); assert.deepEqual(model.pages.map(page => page.id), ['a', 'b', 'c']);
  });
}

test('page actions do not interrupt a busy operation or an ongoing page drag', async () => {
  const { model, context, click } = setup();
  const before = model.sessionSnapshot();
  for (const guard of ['busy', 'pageDrag']) {
    context[guard] = true;
    for (const title of ['コピー', '削除', '左に90°回転', '右に90°回転']) await click('b', title);
    context[guard] = false;
  }
  assert.deepEqual(model.sessionSnapshot(), before);
});
