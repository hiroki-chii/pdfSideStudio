import { EditorModel, MAX_TOTAL_BYTES, sourceAppearance } from './model.js';
import { applyEditorOperation, createEditorOperation } from './editor-operation.js';

// Each worker owns one document. Its message queue orders operations across
// all attached views. PDF blobs are shared in memory and sent only on arrival.
export function createEditorSyncHost() {
  const ports = new Set(), sources = new Map();
  let model, sessionId, editorTab;

  function attach(port) {
    const leave = () => {
      if (editorTab?.port === port) editorTab = undefined;
      if (ports.delete(port) && !ports.size) {
        model = undefined;
        sessionId = undefined;
        editorTab = undefined;
        sources.clear();
      }
      port.close();
    };
    port.onclose = leave;
    port.onmessage = ({ data }) => {
      const { type, id } = data;
      try {
        if (type === 'join') {
          if ((!model && !data.initial) || (data.sessionId && data.sessionId !== sessionId)) {
            port.postMessage({ type: 'reply', id, value: null });
            return;
          }
          if (model && data.initial) {
            throw new Error('このウィンドウで編集中のタブが開いています。現在の編集を保存してから、サイドパネルを開き直してください。');
          }
          if (!model) {
            model = new EditorModel();
            sessionId = crypto.randomUUID();
            model.restoreSession(data.initial);
            for (const [key, source] of data.initial.sources) sources.set(key, source);
          }
          if (Number.isInteger(data.tabId) && data.tabId >= 0) {
            if (editorTab?.port && editorTab.id !== data.tabId) {
              throw new Error('この編集はすでに別のタブで開いています。');
            }
            editorTab = { id: data.tabId, port };
          }
          ports.add(port);
          port.postMessage({ type: 'reply', id, value: { ...model.sessionSnapshot(), sources: [...sources], sessionId } });
          return;
        }
        if (!ports.has(port)) return;
        if (type === 'leave') { leave(); return; }
        if (type === 'barrier') { port.postMessage({ type: 'reply', id }); return; }
        if (type === 'editor-tab') {
          // Keep the ID during startup, before the new tab attaches its port.
          if (!editorTab?.port && Number.isInteger(data.tabId) && data.tabId >= 0) {
            editorTab = { id: data.tabId, expires: Date.now() + 60_000 };
          }
          if (!editorTab?.port && editorTab?.expires <= Date.now()) editorTab = undefined;
          port.postMessage({ type: 'reply', id, value: editorTab?.id ?? null });
          return;
        }
        if (type !== 'edit') return;

        const added = new Map(data.sources.map(([key, source], index) => [
          key, { ...source, ...sourceAppearance(sources.size + index + 1) },
        ]));
        const size = [...sources.values(), ...added.values()].reduce((total, source) => total + source.size, 0);
        if (size > MAX_TOTAL_BYTES) throw new Error('同期中の読み込み総量が150MiBを超えます。');
        const before = model.snapshot();
        applyEditorOperation(model, data.operation, pages => {
          if (pages.some(page => !sources.has(page.sourceId) && !added.has(page.sourceId))) {
            throw new Error('変更に必要な元のPDFが見つかりません。');
          }
        });
        for (const [key, source] of added) sources.set(key, source);
        const operation = data.operation.type === 'commit'
          ? createEditorOperation({ type: 'commit', before, after: model.snapshot() })
          : { type: data.operation.type };
        for (const view of ports) view.postMessage({
          type: 'edit', id: view === port ? id : undefined, operation, sources: [...added],
        });
      } catch (error) {
        port.postMessage({ type: type === 'edit' ? 'reject' : 'reply', id, error: error.message });
      }
    };
  }
  return { attach };
}
