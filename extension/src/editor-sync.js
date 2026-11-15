import { EditorModel } from './model.js';
import { applyEditorOperation, createEditorOperation } from './editor-operation.js';

export function sharePdfSource({ preview, bytes, ...source }) {
  return { ...source, blob: new Blob([bytes], { type: 'application/pdf' }) };
}

export async function connectEditorSync(name, { initial, sessionId, tabId, allowMissing = false, onUpdate, onError,
  createWorker = () => new SharedWorker(new URL('./editor-sync-worker.js', import.meta.url), { name, type: 'module' }),
} = {}) {
  const worker = createWorker(), port = worker.port;
  const model = new EditorModel(), sources = new Map();
  const pending = new Map(), requests = new Map();
  let nextId = 0, revision = 0, displayedRevision = 0, conflict, closed = false, ready = false;

  function close(error = new Error('編集の同期を終了しました。')) {
    if (closed) return;
    closed = true;
    port.postMessage({ type: 'leave' });
    port.close();
    for (const request of requests.values()) request.finish(error);
    pending.clear();
  }
  function fail() {
    if (closed) return;
    const error = new Error('画面間の同期が切れました。この画面の編集は保存できます。');
    close(error);
    if (ready) onError?.(error);
  }
  worker.onerror = fail;
  port.onclose = fail;
  port.onmessageerror = fail;
  port.onmessage = ({ data }) => {
    if (closed) return;
    if (data.type === 'reply') {
      requests.get(data.id)?.finish(data.error ? new Error(data.error) : null, data.value);
      return;
    }
    const own = pending.delete(data.id);
    try {
      if (data.type === 'reject') {
        conflict = data.error;
        revision++;
      } else {
        applyEditorOperation(model, data.operation);
        for (const [id, source] of data.sources) sources.set(id, source);
        if (!own) revision++;
      }
    } catch { fail(); return; }
    onUpdate?.();
  };

  function request(type, data = {}) {
    return new Promise((resolve, reject) => {
      if (closed) { reject(new Error('編集の同期が切れています。')); return; }
      const id = ++nextId;
      const timer = setTimeout(() => {
        requests.get(id)?.finish(new Error('編集の同期に時間がかかっています。もう一度お試しください。'));
      }, 5_000);
      const finish = (error, session) => {
        clearTimeout(timer);
        requests.delete(id);
        if (error) reject(error);
        else resolve(session);
      };
      requests.set(id, { finish });
      try { port.postMessage({ type, id, ...data }); }
      catch (error) { finish(error); }
    });
  }

  try {
    const session = await request('join', { initial, sessionId, tabId });
    if (!session) {
      if (allowMissing) { close(); return null; }
      throw new Error('同期する編集画面が見つかりません。元の画面からタブを開き直してください。');
    }
    sessionId = session.sessionId;
    model.restoreSession(session);
    for (const [id, source] of session.sources) sources.set(id, source);
    ready = true;
  } catch (error) { close(); throw error; }

  function submit(change, localSources) {
    const id = ++nextId, added = new Map();
    const sent = new Set([...pending.values()].flat());
    for (const { sourceId } of change.after.pages) {
      if (!sources.has(sourceId) && !sent.has(sourceId) && !added.has(sourceId) && localSources.has(sourceId)) {
        added.set(sourceId, sharePdfSource(localSources.get(sourceId)));
      }
    }
    pending.set(id, [...added.keys()]);
    try { port.postMessage({ type: 'edit', id, operation: createEditorOperation(change), sources: [...added] }); }
    catch { fail(); }
  }

  return {
    name, sessionId, close, submit,
    barrier: () => request('barrier'),
    getEditorTab: () => request('editor-tab'),
    rememberEditorTab: tabId => request('editor-tab', { tabId }),
    get needsUpdate() { return !pending.size && displayedRevision !== revision; },
    snapshot: () => ({ ...model.sessionSnapshot(), sources: [...sources], revision, conflict }),
    markDisplayed(version) {
      displayedRevision = version;
      if (version === revision) conflict = null;
    },
  };
}
