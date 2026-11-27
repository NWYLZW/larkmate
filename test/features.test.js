import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { LarkMateClient } from '../src/client.js';
import { uploadFile, crc32 } from '../src/upload.js';

const proto = await protobuf.load(fileURLToPath(new URL('../proto/lark.proto', import.meta.url)));
const encode = (name, value) => proto.lookupType(name).encode(proto.lookupType(name).fromObject(value)).finish();
const decode = (name, bytes) => proto.lookupType(name).decode(bytes);

test('inbox returns page cursor, boxes and read-only chat IDs', async () => {
  const calls = [];
  const gateway = { decode, async call(command, type, body) {
    calls.push({ command, type, body });
    return { packet: { payload: encode('PullFeedCardsResponse', {
      cards: [{ id: '123', type: 1, updateTime: '100' }, { id: '456', type: 5 }],
      chats: { 123: { id: '123', type: 1, name: 'Example' } }, nextCursor: '789',
    }) } };
  } };
  const result = await new LarkMateClient(gateway).chats({ limit: 10 });
  assert.deepEqual(result.items, [{ id: '123', type: 'p2p', name: 'Example', updatedAt: '100', unreadCount: null, manualUnread: null, unread: null }]);
  assert.deepEqual(result.boxes, [{ id: '456' }]);
  assert.equal(result.nextCursor, '789');
  assert.equal(calls[0].command, 1000);
  assert.equal(calls[0].body.pullType, 1);
  await new LarkMateClient(gateway).chats({ cursor: '789', parent: '456' });
  assert.equal(calls[1].body.pullType, 2);
});

test('history pagination does not overlap the final shorter page and filters only scanned positions', async () => {
  const calls = [];
  const gateway = { decode, async call(command, type, body) {
    calls.push({ command, body });
    if (command === 64) return { packet: { payload: encode('PullChatsByIdsResponse', { chats: { 500: { id: '500', lastMessagePosition: 5 } } }) } };
    const messages = Object.fromEntries(body.positions.map(position => [position, {
      id: String(position), type: 4, fromId: position === 2 ? '2' : '1', content: encode('TextContent', { text: `message ${position}` }),
    }]));
    return { packet: { payload: encode('PullMessagesByPositionsResponse', { messages }) } };
  } };
  const result = await new LarkMateClient(gateway).historyPages({ chatId: '500', limit: 3, pages: 3, sender: '1' });
  assert.deepEqual(calls.filter(x => x.command === 43).map(x => x.body.positions), [[3, 4, 5], [1, 2]]);
  assert.deepEqual(result.items.map(x => x.position), [1, 3, 4, 5]);
  assert.equal(result.scannedPositions, 5);
  assert.equal(result.nextStart, null);
  assert.equal(result.filterScope, 'scanned_positions_only');
});

test('upload verifies each chunk, sends one message, and reports missing acceptance as uncertain', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-upload-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'example.txt');
  const contents = Buffer.from('sample file');
  await writeFile(path, contents);
  const calls = [];
  const gateway = { encode, decode, async authenticate() {}, async uploadRequest(pathname, body) {
    calls.push(pathname.split('?')[0]);
    if (pathname === '/upload/create') {
      assert.equal(decode('CreateFileUploadRequest', body).fileName, 'example.txt');
      return encode('CreateFileUploadResponse', { uploadId: 'file-key-1' });
    }
    if (pathname.startsWith('/upload/part')) return encode('UploadFilePartResponse', { partId: 1, crc32: crc32(body) });
    const complete = decode('CompleteFileUploadRequest', body);
    assert.equal(complete.partToCrc32[1], crc32(contents));
    return encode('CompleteFileUploadResponse', { code: 0 });
  }, async call(cmd, type, body) {
    calls.push(cmd);
    assert.equal(body.type, 3);
    assert.equal(body.content.fileKey, 'file-key-1');
    const wire = decode('PutMessageRequest', encode('PutMessageRequest', body));
    assert.equal(Number(wire.content.fileSize), contents.length);
    return { requestId: 'req', packet: {} };
  } };
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const result = await new LarkMateClient(gateway).sendFile({ chatId: '500', path });
  assert.equal(result.status, 'submitted_unconfirmed');
  assert.deepEqual(calls, ['/upload/create', '/upload/part', '/upload/complete', 5]);
  gateway.uploadRequest = async path => path === '/upload/create'
    ? encode('CreateFileUploadResponse', { uploadId: 'file-key-1' })
    : encode('UploadFilePartResponse', { partId: 1, crc32: 0 });
  await assert.rejects(uploadFile(gateway, path), { code: 'UPLOAD_FAILED' });
});

test('history returns file metadata and applies bounded time filters', async () => {
  const gateway = { decode, async call(command) {
    if (command === 64) return { packet: { payload: encode('PullChatsByIdsResponse', { chats: { 500: { id: '500', lastMessagePosition: 2 } } }) } };
    return { packet: { payload: encode('PullMessagesByPositionsResponse', { messages: {
      1: { id: '1', type: 3, fromId: '1', createTime: '1700000000', content: encode('FileContent', { key: 'key', name: 'report.txt', size: '123' }) },
      2: { id: '2', type: 4, fromId: '1', content: encode('TextContent', { text: 'unknown time' }) },
    } }) } };
  } };
  const c = new LarkMateClient(gateway);
  const page = await c.historyPages({ chatId: '500', limit: 2, after: 1700000000 });
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.items[0].resource, { key: 'key', name: 'report.txt', size: '123', mime: null });
  assert.equal(page.missingTimestamps, 1);
  await assert.rejects(c.historyPages({ chatId: '500', after: 2, before: 1 }), { code: 'INVALID_ARGUMENT' });
});

test('feed read state distinguishes manual marks, message counts and unavailable data', async () => {
  const gateway = { decode, async call() { return { packet: { payload: encode('PullFeedCardsResponse', {
    cards: [
      { id: '100', type: 1, feedCardField: { markAsUnread: { unread: true } } },
      { id: '101', type: 1, feedCardField: { markAsUnread: { unread: false } } },
      { id: '102', type: 1 },
    ], chats: { 100: { id: '100', newMessageCount: 0 }, 101: { id: '101', newMessageCount: 0 }, 102: { id: '102' } },
  }) } }; } };
  const result = await new LarkMateClient(gateway).chats({ scope: 'done' });
  assert.equal(result.scope, 'done');
  assert.deepEqual(result.items.map(x => x.unread), [true, false, null]);
});
