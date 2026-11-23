import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import { EditorModel, MAX_TOTAL_BYTES } from '../src/model.js';
import { connectEditorSync, sharePdfSource } from '../src/editor-sync.js';
import { createEditorSyncHost } from '../src/editor-sync-host.js';

const source = (size = 2) => ({ bytes: new Uint8Array([1, 2]), size, name: 'fixture.pdf',
  pages: [{ rotation: 0 }, { rotation: 0 }], preview: { getPage() {} } });
const page = (id, sourceId = 'pdf') => ({ id, sourceId, index: 0, rotation: 0, strokes: [], watermark: null });

async function setup(t, initialModel = new EditorModel(), initialSources = new Map()) {
  const host = createEditorSyncHost();
  const ports = [];
  t.after(() => { for (const port of ports) port.close(); });
  async function join(initial, options) {
    const { port1, port2 } = new MessageChannel();
    ports.push(port1, port2);
    const disconnected = once(port1, 'close');
    host.attach(port1);
    const sync = await connectEditorSync('fixture', { ...options, initial, createWorker: () => ({ port: port2 }) });
    if (!sync) return null;
    const model = new EditorModel();
    model.restoreSession(sync.snapshot());
    const sources = new Map();
    model.onChange = change => sync.submit(change, sources);
    return { model, sources, sync, disconnected, async refresh() {
      await sync.barrier();
      const latest = sync.snapshot();
      model.restoreSession(latest);
      sync.markDisplayed(latest.revision);
      return latest;
    } };
  }
  const panel = await join({ ...initialModel.sessionSnapshot(),
    sources: [...initialSources].map(([key, value]) => [key, sharePdfSource(value)]) });
  const tab = await join();
  return { panel, tab, join };
}

test('both screens share PDF sources, edits and an ordered history even after one closes', async t => {
  const { panel, tab, join } = await setup(t);
  panel.sources.set('pdf', source());
  panel.model.commit([page('first'), page('second')], { activeId: 'second' });
  await panel.sync.barrier();
  const imported = await tab.refresh();
  assert.equal(tab.model.activeId, 'second');
  assert.deepEqual([...new Uint8Array(await imported.sources[0][1].blob.arrayBuffer())], [1, 2]);

  const note = { id: 'note', tool: 'text', text: 'before', color: 'black' };
  panel.model.update(new Set(['first']), record => ({ ...record, rotation: 90 }));
  tab.model.update(new Set(['first']), record => ({ ...record, strokes: [note] }));
  await Promise.all([panel.sync.barrier(), tab.sync.barrier()]);
  await Promise.all([panel.refresh(), tab.refresh()]);
  assert.deepEqual(panel.model.pages, tab.model.pages);
  assert.deepEqual(panel.model.pages[0], { ...page('first'), rotation: 90, strokes: [note] });
  assert.equal(tab.model.past.length, 3);

  panel.sync.close();
  tab.model.undo();
  const undone = await tab.refresh();
  assert.equal(undone.past.length, 2);
  assert.equal(undone.future.length, 1);
  const reopened = await join(undefined, { allowMissing: true });
  assert.equal(reopened.sync.sessionId, tab.sync.sessionId);
  assert.deepEqual(reopened.model.pages, tab.model.pages);
  reopened.model.redo();
  await reopened.sync.barrier();
  await tab.refresh();
  assert.deepEqual(tab.model.pages[0], { ...page('first'), rotation: 90, strokes: [note] });
});

test('reopening without a live editor stays empty and an old invitation cannot join a new session', async t => {
  const original = new EditorModel();
  original.commit([page('first')]);
  const { panel, tab, join } = await setup(t, original, new Map([['pdf', source()]]));
  const sessionId = tab.sync.sessionId;
  panel.sync.close();
  tab.sync.close();
  await Promise.all([panel.disconnected, tab.disconnected]);
  assert.equal(await join(undefined, { allowMissing: true }), null);

  const next = await join({ ...new EditorModel().sessionSnapshot(), sources: [] });
  assert.notEqual(next.sync.sessionId, sessionId);
  assert.equal(await join(undefined, { sessionId, allowMissing: true }), null);
  const reopened = await join(undefined, { sessionId: next.sync.sessionId });
  assert.deepEqual(reopened.model.pages, []);
});

test('the editor tab is tracked during launch and shared with a reopened panel until it closes', async t => {
  const { panel, join } = await setup(t);
  assert.equal(await panel.sync.getEditorTab(), null);
  await panel.sync.rememberEditorTab(12);
  assert.equal(await panel.sync.getEditorTab(), 12);
  const editor = await join(undefined, { tabId: 12, sessionId: panel.sync.sessionId });
  await assert.rejects(join(undefined, { tabId: 13, sessionId: panel.sync.sessionId }), /別のタブ/);
  await panel.sync.rememberEditorTab(13);
  assert.equal(await panel.sync.getEditorTab(), 12);

  panel.sync.close();
  await panel.disconnected;
  const reopened = await join(undefined, { allowMissing: true });
  assert.equal(await reopened.sync.getEditorTab(), 12);
  editor.sync.close();
  await editor.disconnected;
  assert.equal(await reopened.sync.getEditorTab(), null);
  await reopened.sync.rememberEditorTab(13);
  assert.equal(await reopened.sync.getEditorTab(), 13);
});

test('overlapping edits preserve the first accepted value and report the conflict to the other screen', async t => {
  const original = new EditorModel();
  original.commit([page('first')]);
  const { panel, tab } = await setup(t, original, new Map([['pdf', source()]]));
  panel.model.update(new Set(['first']), record => ({ ...record, rotation: 90 }));
  tab.model.update(new Set(['first']), record => ({ ...record, rotation: 270 }));
  await Promise.all([panel.sync.barrier(), tab.sync.barrier()]);
  const states = await Promise.all([panel.refresh(), tab.refresh()]);
  assert.equal(states.filter(state => /同じ内容が変更/.test(state.conflict)).length, 1);
  assert.deepEqual(panel.model.pages, tab.model.pages);
  assert.ok([90, 270].includes(tab.model.active.rotation));
  assert.equal(tab.model.past.length, 2);

  tab.model.update(new Set(['first']), record => ({ ...record, rotation: 180 }));
  tab.model.undo();
  tab.model.redo();
  await tab.refresh();
  await panel.refresh();
  assert.equal(panel.model.active.rotation, 180);
  assert.equal(panel.model.past.length, 3);
});

test('independent concurrent imports are kept in commit order with distinct source numbers', async t => {
  const { panel, tab } = await setup(t);
  panel.sources.set('panel-pdf', source());
  tab.sources.set('tab-pdf', source());
  panel.model.commit([page('panel-page', 'panel-pdf')]);
  tab.model.commit([page('tab-page', 'tab-pdf')]);
  await Promise.all([panel.sync.barrier(), tab.sync.barrier()]);
  const [first, second] = await Promise.all([panel.refresh(), tab.refresh()]);
  assert.deepEqual(first.state.pages, second.state.pages);
  assert.deepEqual(first.sources.map(([, item]) => item.number), [1, 2]);
  assert.equal(new Set(first.sources.map(([, item]) => item.color)).size, 2);
  assert.deepEqual(new Set(first.state.pages.map(item => item.id)), new Set(['panel-page', 'tab-page']));
});

test('page reordering and deletion synchronize without losing edits to remaining pages', async t => {
  const original = new EditorModel();
  original.commit([page('a'), page('b'), page('c')]);
  const { panel, tab } = await setup(t, original, new Map([['pdf', source()]]));
  panel.model.moveBefore('c', 'a');
  tab.model.update(new Set(['a']), record => ({ ...record, rotation: 90 }));
  await Promise.all([panel.sync.barrier(), tab.sync.barrier()]);
  await tab.refresh();
  assert.deepEqual(tab.model.pages.map(item => item.id), ['c', 'a', 'b']);
  tab.model.commit(tab.model.pages.filter(item => item.id !== 'b'));
  await tab.sync.barrier();
  await panel.refresh();
  assert.deepEqual(panel.model.pages.map(item => [item.id, item.rotation]), [['c', 0], ['a', 90]]);
  panel.model.undo();
  await panel.sync.barrier();
  await tab.refresh();
  assert.deepEqual(tab.model.pages.map(item => item.id), ['c', 'a', 'b']);
});

test('document watermark settings cover pages added concurrently and restore through shared history', async t => {
  const original = new EditorModel();
  original.commit([page('first')]);
  const { panel, tab } = await setup(t, original, new Map([['pdf', source()]]));
  const watermark = { text: 'DRAFT', color: '#736c90', position: 'top-left' };
  panel.model.commit([...panel.model.pages, page('second')]);
  await panel.sync.barrier();
  tab.model.commit(tab.model.pages, { documentWatermark: watermark });
  const applied = await tab.refresh();
  assert.ok(!applied.conflict);
  assert.deepEqual(tab.model.pages.map(item => item.watermark), [watermark, watermark]);
  await panel.refresh();

  tab.model.commit(tab.model.pages, { documentWatermark: null });
  await tab.sync.barrier();
  panel.model.commit([...panel.model.pages, page('third')]);
  const removed = await panel.refresh();
  assert.ok(!removed.conflict);
  assert.deepEqual(panel.model.pages.map(item => item.watermark), [null, null, null]);
  panel.model.undo();
  panel.model.undo();
  await panel.sync.barrier();
  await tab.refresh();
  assert.deepEqual(tab.model.pages.map(item => item.watermark), [watermark, watermark]);
});

test('the shared byte limit rejects an import without modifying the document or history', async t => {
  const original = new EditorModel();
  original.commit([page('first')]);
  const { panel, tab } = await setup(t, original, new Map([['pdf', source(MAX_TOTAL_BYTES)]]));
  tab.sources.set('extra', source());
  tab.model.commit([...tab.model.pages, page('extra', 'extra')]);
  const snapshot = await tab.refresh();
  assert.match(snapshot.conflict, /150MiB/);
  assert.equal(snapshot.sources.length, 1);
  assert.deepEqual(snapshot.state.pages, panel.model.pages);
  assert.equal(snapshot.past.length, 1);
});
