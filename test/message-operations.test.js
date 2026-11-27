import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { LarkMateClient } from '../src/client.js';
import { downloadFile } from '../src/download.js';
import { crc32 } from '../src/upload.js';

const root = await protobuf.load(fileURLToPath(new URL('../proto/lark.proto', import.meta.url)));
const encode = (name, value) => root.lookupType(name).encode(root.lookupType(name).fromObject(value)).finish();
const decode = (name, bytes) => root.lookupType(name).decode(bytes);
const bigId = '7712345678901234567';

test('global message search preserves its session and opaque cursor across pages', async () => {
  const calls = [];
  const gateway = { decode, async call(command, type, body) {
    calls.push({ command, body });
    return { packet: { payload: encode('UniversalSearchResponse', {
      header: { total: 2, hasMore: calls.length === 1, paginationToken: 'opaque-token' },
      results: [{ id: calls.length === 1 ? bigId : '7712345678901234566', type: 5,
        titleHighlighted: '<em>Example</em>', summaryHighlighted: 'a <em>match</em>',
        meta: { message: { messageId: bigId, chatId: '500', senderId: '600', position: 12, createTime: '1700000000' } } }],
    }) } };
  } };
  const c = new LarkMateClient(gateway);
  const first = await c.searchMessages({ query: 'match', limit: 1 });
  const second = await c.searchMessages({ query: 'match', limit: 1, cursor: first.nextCursor });
  assert.equal(first.items[0].id, bigId);
  assert.equal(first.items[0].chatId, '500');
  assert.equal(first.items[0].snippet, 'a match');
  assert.equal(second.nextCursor, null);
  assert.equal(calls[1].body.header.searchSession, calls[0].body.header.searchSession);
  assert.equal(calls[1].body.header.paginationToken, 'opaque-token');
  assert.equal(calls[1].body.header.sessionSeqId, 2);
  await assert.rejects(c.searchMessages({ query: 'other', cursor: first.nextCursor }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 2);
});

test('search errors and missing continuation tokens are not mistaken for empty results', async () => {
  let header = { errorCode: 91 };
  const gateway = { decode, async call() { return { packet: { payload: encode('UniversalSearchResponse', { header }) } }; } };
  const c = new LarkMateClient(gateway);
  await assert.rejects(c.searchMessages({ query: 'example' }), { code: 'SEARCH_REJECTED' });
  header = { hasMore: true };
  await assert.rejects(c.searchMessages({ query: 'example' }), { code: 'INVALID_RESPONSE' });
});

test('message link is returned only when token and trusted link match', async () => {
  let url = 'https://applink.feishu.cn/client/message/link/open?token=abc%3D';
  const gateway = { decode, async call(cmd, type, body) {
    assert.equal(cmd, 1150);
    assert.equal(body.messageId, bigId);
    return { packet: { payload: encode('MessageLinkResponse', { token: 'abc=', url }) } };
  } };
  const c = new LarkMateClient(gateway);
  assert.equal((await c.messageLink({ chatId: '500', messageId: bigId })).url, url);
  url = 'https://example.com/client/message/link/open?token=abc%3D';
  await assert.rejects(c.messageLink({ chatId: '500', messageId: bigId }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(c.messageLink({ chatId: '500', messageId: '99999999999999999999' }), { code: 'INVALID_ARGUMENT' });
});

test('message mutations retain 64-bit IDs and mark unconfirmed writes honestly', async () => {
  const calls = [];
  const gateway = { encode, decode, async authenticate() {}, async call(cmd, type, body, options) {
    const wire = decode(type, encode(type, body));
    calls.push({ cmd, wire, options });
    return { requestId: 'request', packet: { payload: cmd === 500 ? encode('PutFavoriteResponse', { ids: [bigId] }) : new Uint8Array() } };
  } };
  const c = new LarkMateClient(gateway);
  await c.reaction({ messageId: bigId });
  await c.reaction({ messageId: bigId, remove: true });
  await c.editMessage({ messageId: bigId, text: 'updated text' });
  await c.forwardMessage({ chatId: '500', messageId: bigId, targetChatId: '600' });
  await c.recallMessage(bigId);
  const favorite = await c.favoriteMessage({ chatId: '500', messageId: bigId });
  await c.removeFavorite(favorite.favoriteId);
  assert.deepEqual(calls.map(x => x.cmd), [25, 26, 900010, 51, 9, 500, 502]);
  assert.equal(String(calls[2].wire.messageId), bigId);
  assert.equal(calls[2].wire.content.richText.innerText, 'updated text');
  assert.equal(calls[2].wire.content.richText.elements.dictionary['2'].property.length, 0);
  assert.equal(calls[3].wire.messageId, bigId);
  assert.equal(calls[3].wire.targets['600'].type, 1);
  assert.equal(favorite.favoriteId, bigId);
  assert.ok(calls.every(x => x.options.mutating));
  await assert.rejects(c.reaction({ messageId: bigId, emoji: 'invalid emoji!' }), { code: 'INVALID_ARGUMENT' });
});

test('favorites expose message metadata and retain IDs when content is unknown', async () => {
  const gateway = { decode, async call(cmd) {
    assert.equal(cmd, 503);
    return { packet: { payload: encode('PullAllFavoritesResponse', { hasMore: true, favs: [
      { id: bigId, type: 1, content: encode('MessageEntity', { id: '42', chatId: '500', type: 4,
        content: encode('TextContent', { text: 'saved message' }) }) },
      { id: '700', type: 2, content: Buffer.from('unknown') },
    ] }) } };
  } };
  const page = await new LarkMateClient(gateway).favorites({ limit: 2 });
  assert.equal(page.items[0].id, bigId);
  assert.equal(page.items[0].message.text, 'saved message');
  assert.equal(page.items[1].message, null);
  assert.equal(page.hasMore, true);
});

test('image send uses completed image key rather than the upload ID', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-image-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'image.png');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO1+p0sAAAAASUVORK5CYII=', 'base64');
  await writeFile(file, image);
  let sent;
  const gateway = { encode, decode, async authenticate() {}, async uploadRequest(path, body) {
    if (path === '/upload/create') {
      assert.equal(decode('CreateFileUploadRequest', body).fileType, 2);
      return encode('CreateFileUploadResponse', { uploadId: 'img_upload_id' });
    }
    if (path.startsWith('/upload/part')) return encode('UploadFilePartResponse', { partId: 1, crc32: crc32(body) });
    assert.equal(decode('CompleteFileUploadRequest', body).mime, 'image/png');
    return encode('CompleteFileUploadResponse', { code: 0, fileKey: 'img_final_key' });
  }, async call(command, type, body) { sent = body; return { requestId: 'request', packet: {} }; } };
  const result = await new LarkMateClient(gateway).sendImage({ chatId: '500', path: file });
  assert.equal(result.status, 'submitted_unconfirmed');
  assert.equal(sent.content.thumbnailKey, 'img_final_key');
  assert.notEqual(sent.content.thumbnailKey, 'img_upload_id');
  await writeFile(file, 'not an image');
  await assert.rejects(new LarkMateClient(gateway).sendImage({ chatId: '500', path: file }), { code: 'FILE_INVALID' });
});

test('download uses message-scoped authorization, streams to a private new file, and does not overwrite', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-download-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'attachment');
  const gateway = { endpoints: { file: 'https://file.example' }, async authenticate() {}, baseHeaders() { return {}; },
    async request(url, options) {
      const data = JSON.parse(url.searchParams.get('data'));
      assert.equal(data.file_key, 'file_key_1');
      assert.equal(data.src.entity_id, bigId);
      assert.equal(data.src.im_ext.chat_id, '500');
      assert.equal(options.redirect, 'manual');
      return new Response('contents', { headers: { 'content-length': '8' } });
    } };
  assert.equal((await downloadFile(gateway, { chatId: '500', messageId: bigId, key: 'file_key_1', output })).bytes, 8);
  assert.equal(await readFile(output, 'utf8'), 'contents');
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(downloadFile(gateway, { chatId: '500', messageId: bigId, key: 'file_key_1', output }), { code: 'DOWNLOAD_WRITE_FAILED' });
  assert.equal(await readFile(output, 'utf8'), 'contents');
  gateway.request = async () => new Response('short', { headers: { 'content-length': '20' } });
  await assert.rejects(downloadFile(gateway, { chatId: '500', messageId: bigId, key: 'file_key_1', output: join(dir, 'partial') }), { code: 'DOWNLOAD_INCOMPLETE' });
  assert.equal(await readFile(join(dir, 'partial'), 'utf8'), 'short');
});
