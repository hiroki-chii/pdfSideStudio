// The receiver reads a job once through a same-origin, per-job channel.
export function createDocumentJobBroker(prefix, timeoutMessage, {
  Channel = globalThis.BroadcastChannel, now = Date.now, lifetime = 60_000, wait = 5_000,
} = {}) {
  const jobs = new Map();
  function remove(id) {
    const entry = jobs.get(id);
    if (!entry) return;
    clearTimeout(entry.timer); entry.channel.close(); jobs.delete(id);
  }
  function store(id, job) {
    remove(id);
    const channel = new Channel(`${prefix}:${id}`);
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
      const channel = new Channel(`${prefix}:${id}`), nonce = crypto.randomUUID();
      const finish = (error, value) => {
        clearTimeout(timer); channel.close();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error(timeoutMessage)), wait);
      channel.onmessage = ({ data }) => {
        if (data?.type !== 'job' || data.nonce !== nonce) return;
        finish(null, data.expires > now() ? data.job : null);
      };
      try { channel.postMessage({ type: 'request', nonce }); } catch (error) { finish(error); }
    });
  }
  return { store, read, remove, close() { for (const id of jobs.keys()) remove(id); } };
}
