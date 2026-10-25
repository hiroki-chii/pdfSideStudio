import { PDF_LIMITS, PdfLimitError } from './limits.js';

// Each operation owns its Worker. A timeout cannot destroy previously imported
// documents or editor state, and termination releases its parser allocations.
export function runPdfJob(job, { progress = () => {}, signal, timeout = job.type === 'load' ? PDF_LIMITS.loadTimeout : PDF_LIMITS.exportTimeout,
  createWorker = () => new Worker(new URL('./pdf-worker.js', import.meta.url), { type: 'module' }) } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('PDF処理を取り消しました。')); return; }
    const worker = createWorker(); let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new Error('PDF処理を取り消しました。'));
    const timer = setTimeout(() => finish(new PdfLimitError('処理時間')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') progress(data.done, data.total);
      else if (data.type === 'error') finish(new Error(data.message));
      else if (data.type === 'result') finish(null, data.result);
    };
    worker.onerror = () => finish(new Error('PDF処理を完了できませんでした。小さなPDFで再度お試しください。'));
    worker.onmessageerror = () => finish(new Error('PDF処理の結果を読み取れませんでした。'));
    try { worker.postMessage(job); } catch (error) { finish(error); }
  });
}

export async function exportDocument(type, records, sources, createOverlay, title, progress) {
  const prepared = []; let overlaySize = 0;
  for (const record of records) {
    const overlay = record.strokes.length || record.watermark ? await createOverlay(record, sources.get(record.sourceId)) : undefined;
    overlaySize += overlay?.bytes.length || 0;
    if (overlaySize > PDF_LIMITS.overlayBytes) throw new PdfLimitError('書き込み画像の総量');
    prepared.push({ ...record, overlay });
  }
  const ids = new Set(records.map(record => record.sourceId));
  const inputs = [...ids].map(id => {
    const source = sources.get(id);
    if (!source) throw new Error('元のPDFが見つかりません。');
    return { id, bytes: source.bytes };
  });
  return runPdfJob({ type, records: prepared, sources: inputs, title }, { progress });
}
