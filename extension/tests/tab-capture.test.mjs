import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const captureCode = app.slice(app.indexOf('const captureSiteAccess'), app.indexOf('function rotate('));
const captureControls = app.slice(app.indexOf('if (globalThis.chrome?.tabs?.captureVisibleTab)'),
  app.indexOf("$('add-files').addEventListener"));

async function setup() {
  const nodes = new Map(), actions = new Map(), events = [], files = [];
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true });
    return nodes.get(id);
  };
  const state = {
    granted: false, tab: { id: 1, windowId: 1, url: 'https://example.test/' },
    request: async () => (state.granted = true), capture: async () => 'data:image/png;base64,iVBORw0KGgo=',
  };
  let permissionRemoved;
  const chrome = {
    permissions: {
      contains: async () => state.granted,
      request: async ({ origins }) => {
        events.push(['request', ...origins]);
        return state.request();
      },
      onAdded: { addListener() {} },
      onRemoved: { addListener(listener) { permissionRemoved = listener; } },
    },
    tabs: {
      query: async () => [state.tab],
      captureVisibleTab: async () => {
        events.push(['capture', state.tab.id]);
        return state.capture();
      },
    },
  };
  vm.runInNewContext(captureCode + captureControls, {
    chrome, $, File, atob, console, setTimeout: callback => callback(),
    on: (id, action) => actions.set(id, action), status() {},
    addFiles: async added => files.push(...added),
  });
  await Promise.resolve();
  return { $, state, events, files, capture: actions.get('capture-tab'),
    captureOnce: actions.get('capture-tab-once'), permissionRemoved };
}

test('first capture requests access before adding a page and later captures reuse the same panel', async () => {
  const { $, state, events, files, capture, permissionRemoved } = await setup();
  assert.equal($('capture-tab').textContent, 'サイトへのアクセスを許可して取り込む');
  const pending = Promise.withResolvers();
  state.request = () => pending.promise;
  const first = capture();
  assert.deepEqual(events, [['request', '<all_urls>']]);
  assert.equal(files.length, 0);

  state.granted = true;
  pending.resolve(true);
  await first;
  assert.equal($('capture-tab').textContent, '表示中のタブを取り込む');
  assert.equal(files[0].type, 'image/png');

  state.tab = { ...state.tab, url: 'https://another.test/' };
  await capture();
  assert.deepEqual(events, [['request', '<all_urls>'], ['capture', 1], ['capture', 1]]);
  assert.equal(files.length, 2);

  state.granted = false;
  await permissionRemoved();
  assert.equal($('capture-tab').textContent, 'サイトへのアクセスを許可して取り込む');
});

test('declining skips capture and leaves temporary access available as a separate action', async () => {
  const { $, state, events, files, capture, captureOnce } = await setup();
  state.request = async () => false;
  await capture();
  assert.deepEqual(events, [['request', '<all_urls>']]);
  assert.equal(files.length, 0);
  assert.equal($('capture-tab-once').hidden, false);
  await captureOnce();
  assert.equal(files.length, 1);
});

test('capture retries a transient failure after approval and aborts if the active tab changes', async () => {
  const { state, events, files, capture } = await setup();
  const successfulCapture = state.capture;
  state.capture = async () => {
    state.capture = successfulCapture;
    throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
  };
  await capture();
  assert.deepEqual(events, [['request', '<all_urls>'], ['capture', 1], ['capture', 1]]);
  assert.equal(files.length, 1);

  state.capture = async () => {
    state.tab = { ...state.tab, id: 2 };
    throw new Error('Failed to capture tab: image readback failed');
  };
  await assert.rejects(capture(), /表示ページが変わりました/);
  assert.deepEqual(events.at(-1), ['capture', 1]);
  assert.equal(files.length, 1);
});
