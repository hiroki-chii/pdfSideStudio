import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = (await readFile(new URL('../src/print.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace('prepare().catch', 'globalThis.done = prepare().catch');

function setup(job, decodeError = false) {
  const events = [], handlers = {}, images = [];
  const button = { disabled: true, addEventListener: (_, action) => { handlers.click = action; } };
  const status = {};
  const document = {
    head: { append() {} },
    getElementById: id => id === 'print-document' ? button : id === 'print-status' ? status : { append: image => images.push(image) },
    createElement: tag => tag === 'style' ? { textContent: '' } : {
      style: {},
      async decode() { events.push('decode'); if (decodeError) throw new Error('decode failed'); },
    },
  };
  const context = vm.createContext({ document, location: { href: 'https://example.test/print.html?job=test' },
    URL: class extends URL {
      static createObjectURL() { return 'blob:test'; }
      static revokeObjectURL() { events.push('revoke'); }
    },
    window: { print: () => events.push('print'), addEventListener: (name, fn) => { handlers[name] = fn; } },
    console: { error() {} },
    readPrintJob: async id => { assert.equal(id, 'test'); return job; },
    deletePrintJob: async () => { events.push('delete'); },
    requestAnimationFrame: fn => { events.push('layout'); fn(); },
  });
  vm.runInContext(script, context);
  return { context, events, handlers, button, status, images, document };
}

test('print tab decodes every page before printing and supports retry after cancellation', async () => {
  const env = setup({ title: 'Edited PDF', pages: [{ blob: {}, width: 595, height: 842 }, { blob: {}, width: 842, height: 595 }] });
  await env.context.done;
  assert.deepEqual(env.events, ['decode', 'decode', 'delete', 'layout', 'layout', 'print']);
  assert.equal(env.button.disabled, false);
  assert.equal(env.document.title, 'Edited PDF');
  assert.match(env.images[1].style.cssText, /width:842pt;height:595pt;page:sheet1/);
  env.handlers.click();
  assert.equal(env.events.at(-1), 'print');
  env.handlers.pagehide();
  assert.deepEqual(env.events.slice(-2), ['revoke', 'revoke']);
});

test('missing print data and image errors show an error without printing incomplete pages', async () => {
  for (const env of [setup(null), setup({ pages: [{ blob: {}, width: 595, height: 842 }] }, true)]) {
    await env.context.done;
    assert.equal(env.button.disabled, true);
    assert.ok(env.status.textContent);
    assert.ok(!env.events.includes('print'));
    assert.ok(!env.events.includes('delete'));
  }
});
