import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolHelp } from '../src/tool-help.js';

function setup() {
  const node = () => ({ children: [], handlers: {}, isConnected: true, open: false,
    addEventListener(type, handler) { this.handlers[type] = handler; },
    append(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    showModal() { this.open = true; },
    close() { this.open = false; this.handlers.close?.(); },
    focus() { this.focused = true; },
    getBoundingClientRect() { return { left: 100, top: 100, right: 400, bottom: 500 }; },
  });
  const nodes = new Map(['tool-help-dialog', 'tool-help-title', 'tool-help-content', 'close-tool-help'].map(id => [id, node()]));
  const buttons = ['select', 'pen', 'text', 'stamp', 'rotation', 'watermark', 'save', 'unknown'].map(toolHelp => ({ ...node(), dataset: { toolHelp } }));
  createToolHelp({ getElementById: id => nodes.get(id), querySelectorAll: () => buttons, createElement: node });
  return { buttons, dialog: nodes.get('tool-help-dialog'), title: nodes.get('tool-help-title'),
    content: nodes.get('tool-help-content'), close: nodes.get('close-tool-help') };
}

test('every menu opens its own guide, replaces previous content and restores focus on close', () => {
  const { buttons, dialog, title, content, close } = setup();
  const titles = new Set();
  for (const button of buttons.slice(0, -1)) {
    button.handlers.click();
    assert.equal(dialog.open, true);
    assert.match(title.textContent, /使い方$/);
    titles.add(title.textContent);
    assert.ok(content.children[0].children.length >= 3);
    const previousList = content.children[0];
    close.handlers.click();
    assert.equal(dialog.open, false);
    assert.equal(button.focused, true);
    button.handlers.click();
    assert.notEqual(content.children[0], previousList);
    assert.equal(content.children.filter(child => child.children.length >= 3).length, button.dataset.toolHelp === 'pen' || button.dataset.toolHelp === 'text' ? 2 : 1);
    dialog.close();
  }
  assert.equal(titles.size, 7);
});

test('unknown guides and repeated opens leave the current dialog intact; removed openers are safe', () => {
  const { buttons, dialog, title } = setup();
  buttons.at(-1).handlers.click();
  assert.equal(dialog.open, false);
  buttons[0].handlers.click();
  const firstTitle = title.textContent;
  buttons[1].handlers.click();
  assert.equal(title.textContent, firstTitle);
  buttons[0].isConnected = false;
  assert.doesNotThrow(() => dialog.close());
  assert.equal(buttons[0].focused, undefined);
});

test('clicking the backdrop on every side closes each guide and restores opener focus', () => {
  for (const [clientX, clientY] of [[99, 200], [401, 200], [200, 99], [200, 501]]) {
    const { buttons, dialog } = setup();
    for (const button of buttons.slice(0, -1)) {
      button.focused = false;
      button.handlers.click();
      const event = { target: dialog, button: 0, isPrimary: true, clientX, clientY,
        stopPropagation() { this.stopped = true; } };
      dialog.handlers.pointerdown(event);
      dialog.handlers.click(event);
      assert.equal(dialog.open, false);
      assert.equal(button.focused, true);
      assert.equal(event.stopped, true);
    }
  }
});

test('content, padding, secondary clicks and drags crossing the dialog edge do not dismiss', () => {
  const { buttons, dialog, content } = setup();
  const inside = { target: dialog, button: 0, clientX: 110, clientY: 110 };
  const outside = { target: dialog, button: 0, clientX: 50, clientY: 50 };
  for (const [down, click] of [
    [inside, inside],
    [{ ...inside, target: content }, { ...inside, target: content }],
    [inside, outside],
    [outside, inside],
    [{ ...outside, button: 2 }, outside],
    [{ ...outside, isPrimary: false }, outside],
  ]) {
    buttons[0].handlers.click();
    dialog.handlers.pointerdown(down);
    dialog.handlers.click(click);
    assert.equal(dialog.open, true);
    dialog.close();
  }
});
