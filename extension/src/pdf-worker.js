import { processPdfJob } from './pdf-jobs.js';

self.onmessage = async ({ data }) => {
  try {
    const result = await processPdfJob(data, (done, total) => self.postMessage({ type: 'progress', done, total }));
    self.postMessage({ type: 'result', result }, result instanceof Uint8Array ? [result.buffer] : []);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || 'PDFの処理に失敗しました。' });
  }
};
