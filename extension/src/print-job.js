// Transfer printable images to a normal tab without depending on the panel staying open.
async function jobStore(mode, operation) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('pdf-side-studio-print', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('jobs');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('jobs', mode);
      const request = operation(transaction.objectStore('jobs'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('印刷データの読み書きに失敗しました。'));
    });
  } finally { db.close(); }
}

export async function storePrintJob(id, job) {
  // Remove abandoned jobs (for example a tab closed before loading).
  await jobStore('readwrite', store => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (cursor.value.createdAt < Date.now() - 60 * 60 * 1000) cursor.delete();
      cursor.continue();
    };
    return request;
  });
  await jobStore('readwrite', store => store.put(job, id));
}

export const readPrintJob = id => jobStore('readonly', store => store.get(id));
export const deletePrintJob = id => jobStore('readwrite', store => store.delete(id));
