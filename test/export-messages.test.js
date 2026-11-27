import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportMessages } from '../src/export-messages.js';

test('exports across pages in newest-first order and preserves continuation information', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-export-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'messages.jsonl');
  const calls = [];
  const client = { async historyPages(options) {
    calls.push(options);
    return calls.length === 1
      ? { items: [{ id: '2', position: 2, text: 'newest' }], scannedPositions: 100, omittedPositions: 2, missingTimestamps: 1, nextStart: 1, nextLimit: 1 }
      : { items: [{ id: '1', position: 1, text: 'older' }], scannedPositions: 1, omittedPositions: 0, missingTimestamps: 0, nextStart: null, nextLimit: null };
  } };
  const result = await exportMessages(client, { chatId: '500', sender: '12', after: 10, output, format: 'jsonl' });
  const records = (await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(x => x.kind), ['metadata', 'message', 'message', 'summary']);
  assert.deepEqual(records.filter(x => x.kind === 'message').map(x => x.id), ['2', '1']);
  assert.equal(calls[1].start, 1);
  assert.equal(calls[1].limit, 1);
  assert.equal(calls[0].sender, '12');
  assert.equal(result.reachedBeginning, true);
  assert.equal(result.omittedPositions, 2);
  assert.equal(result.missingTimestamps, 1);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(exportMessages(client, { chatId: '500', output }), { code: 'EXPORT_WRITE_FAILED' });
});

test('bounded and failed exports remain clearly incomplete', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-export-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const partial = join(dir, 'partial.md');
  const client = { async historyPages() { return { items: [], scannedPositions: 100, omittedPositions: 0, missingTimestamps: 0, nextStart: 10, nextLimit: 100 }; } };
  const result = await exportMessages(client, { chatId: '500', output: partial, maxPages: 1 });
  assert.equal(result.reachedBeginning, false);
  assert.equal(result.nextStart, 10);
  assert.match(await readFile(partial, 'utf8'), /"reachedBeginning":false/);
  const failed = join(dir, 'failed.md');
  await assert.rejects(exportMessages({ async historyPages() { throw Object.assign(new Error(), { code: 'REQUEST_FAILED' }); } }, { chatId: '500', output: failed }), { code: 'EXPORT_INCOMPLETE' });
  assert.doesNotMatch(await readFile(failed, 'utf8'), /导出统计/);
  const existing = join(dir, 'existing');
  await writeFile(existing, 'keep');
  await assert.rejects(exportMessages(client, { chatId: '500', output: existing }), { code: 'EXPORT_WRITE_FAILED' });
  assert.equal(await readFile(existing, 'utf8'), 'keep');
  await assert.rejects(exportMessages(client, { chatId: '500', output: join(dir, 'invalid'), after: 20, before: 10 }), { code: 'INVALID_ARGUMENT' });
});
