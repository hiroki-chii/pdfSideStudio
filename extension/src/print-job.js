// Print images live only in memory. BroadcastChannel transfers Blobs between
// extension pages of the same origin; no document data is written to storage.
export function createPrintJobBroker({ Channel = globalThis.BroadcastChannel, now = Date.now, lifetime = 60_000, wait = 5_000 } = {}) {
  const jobs = new Map();
  function remove(id) {
    const entry = jobs.get(id);
    if (!entry) return;
    clearTimeout(entry.timer); entry.channel.close(); jobs.delete(id);
  }
  function store(id, job) {
    remove(id);
    const channel = new Channel(`pdf-side-studio-print:${id}`);
    const expires = now() + lifetime;
    const entry = { channel, timer: setTimeout(() => remove(id), lifetime) };
    jobs.set(id, entry);
    channel.onmessage = ({ data }) => {
      if (data?.type !== 'request' || typeof data.nonce !== 'string') return;
      try {
        if (now() < expires) channel.postMessage({ type: 'job', nonce: data.nonce, job, expires });
      } finally { remove(id); }
    };
  }
  function read(id) {
    return new Promise((resolve, reject) => {
      const channel = new Channel(`pdf-side-studio-print:${id}`), nonce = crypto.randomUUID();
      const finish = (error, value) => {
        clearTimeout(timer); channel.close();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('印刷データの受信期限が切れました。編集画面からやり直してください。')), wait);
      channel.onmessage = ({ data }) => {
        if (data?.type !== 'job' || data.nonce !== nonce) return;
        finish(null, data.expires > now() ? data.job : null);
      };
      try { channel.postMessage({ type: 'request', nonce }); } catch (error) { finish(error); }
    });
  }
  return { store, read, remove, close() { for (const id of jobs.keys()) remove(id); } };
}

const broker = createPrintJobBroker();
export const storePrintJob = async (id, job) => broker.store(id, job);
export const readPrintJob = id => broker.read(id);
export const deletePrintJob = async id => broker.remove(id);
globalThis.addEventListener?.('pagehide', () => broker.close());

// Migrate old releases: delete previously persisted print images on startup.
export function purgeLegacyPrintJobs(storage = globalThis.indexedDB) {
  if (!storage) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = storage.deleteDatabase('pdf-side-studio-print');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('以前の印刷データを削除できませんでした。'));
    request.onblocked = () => reject(new Error('以前の印刷タブを閉じ、再読み込みしてください。保存済み印刷データの削除が保留されています。'));
  });
}
