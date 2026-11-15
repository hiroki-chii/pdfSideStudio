import { createDocumentJobBroker } from './document-job.js';

export function createPrintJobBroker(options) {
  return createDocumentJobBroker('pdf-side-studio-print',
    '印刷データの受信期限が切れました。編集画面からやり直してください。', options);
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
