import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrintJobBroker, purgeLegacyPrintJobs } from '../src/print-job.js';

test('print images cross real channels in memory, are consumed once, and survive producer cleanup after transfer', async () => {
  const producer = createPrintJobBroker(), consumer = createPrintJobBroker({ wait: 2_000 });
  const replay = createPrintJobBroker({ wait: 40 });
  const id = crypto.randomUUID(), blob = new Blob(['private page image'], { type: 'image/png' });
  try {
    producer.store(id, { pages: [{ blob, width: 200, height: 300 }], title: 'private' });
    const result = await consumer.read(id);
    producer.close();
    assert.equal(await result.pages[0].blob.text(), 'private page image');
    await assert.rejects(replay.read(id), /受信期限/);
  } finally { producer.close(); consumer.close(); replay.close(); }
});

test('expired, removed and abandoned jobs cannot be retrieved', async () => {
  let current = 0;
  const producer = createPrintJobBroker({ now: () => current, lifetime: 20 });
  const consumer = createPrintJobBroker({ now: () => current, wait: 30 });
  try {
    for (const mode of ['expired', 'removed', 'closed']) {
      current = 0; const id = crypto.randomUUID();
      producer.store(id, { pages: [{ blob: new Blob(['secret']) }] });
      if (mode === 'expired') current = 21;
      if (mode === 'removed') producer.remove(id);
      if (mode === 'closed') producer.close();
      await assert.rejects(consumer.read(id), /受信期限/);
    }
  } finally { producer.close(); consumer.close(); }
});

test('legacy persisted print database is deleted and blocked/error migration is reported', async () => {
  for (const outcome of ['onsuccess', 'onblocked', 'onerror']) {
    const request = {}, calls = [];
    const result = purgeLegacyPrintJobs({ deleteDatabase(name) { calls.push(name); return request; } });
    request[outcome]();
    if (outcome === 'onsuccess') await result;
    else await assert.rejects(result, outcome === 'onblocked' ? /保留/ : /削除できません/);
    assert.deepEqual(calls, ['pdf-side-studio-print']);
  }
});
