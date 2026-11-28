import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { FeishuError, requireInt64Id } from './errors.js';
import { loadBrokerToken } from './agent-broker.js';

const MAX = 100 * 1024 * 1024;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const only = (x, keys) => object(x) && Object.keys(x).every(key => keys.includes(key));
const bad = () => { throw new FeishuError('INVALID_REQUEST', 'Invalid file transfer request.'); };
const denied = () => { throw new FeishuError('POLICY_DENIED', 'This action or resource is not permitted by the broker policy.'); };
const safeName = name => typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) <= 200
  && name !== '.' && name !== '..' && !/[\/\\\x00-\x1f\x7f]/.test(name);

// The privileged process never receives a client-provided path. Each transfer gets
// a private, disposable directory and only validated, single-component names.
export async function handleFileRequest({ req, res, policy, getServices, authorize, answer }) {
  let dir, dispatched = false, command;
  try {
    if (req.headers['content-type'] !== 'application/octet-stream' || typeof req.headers['x-larkmate-file'] !== 'string' || req.headers['x-larkmate-file'].length > 4096) bad();
    let meta;
    try { meta = JSON.parse(Buffer.from(req.headers['x-larkmate-file'], 'base64url').toString('utf8')); } catch { bad(); }
    command = meta?.command;
    const upload = ['send-file', 'send-image', 'group-avatar-set'].includes(command);
    if (!only(meta, upload ? ['command', 'chatId', 'name', 'size'] : ['command', 'chatId', 'messageId', 'key', 'position']) || (!upload && command !== 'download-file')) bad();
    authorize(policy, { command, service: 'files', method: upload ? 'upload' : 'download', args: [{ chatId: meta.chatId }] });
    requireInt64Id(meta.chatId, 'chat ID');
    if (upload) {
      if (!safeName(meta.name) || !Number.isSafeInteger(meta.size) || meta.size < 1 || meta.size > policy.maxFileBytes || (['send-image', 'group-avatar-set'].includes(command) && meta.size > 10 * 1024 * 1024)) bad();
      dir = await mkdtemp(join(tmpdir(), 'larkmate-transfer-'));
      const path = join(dir, meta.name);
      const file = await open(path, 'wx', 0o600);
      let bytes = 0;
      try {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > meta.size || bytes > policy.maxFileBytes) bad();
          await file.writeFile(chunk);
        }
      } finally { await file.close(); }
      if (bytes !== meta.size || !req.complete || res.destroyed) bad();
      const { client } = await getServices();
      if (res.destroyed) return;
      dispatched = true;
      const data = await client[command === 'send-file' ? 'sendFile' : command === 'send-image' ? 'sendImage' : 'setGroupAvatar']({ chatId: meta.chatId, path });
      answer(200, { ok: true, data });
    } else {
      requireInt64Id(meta.messageId, 'message ID');
      if (typeof meta.key !== 'string' || !/^[\w.-]{1,200}$/.test(meta.key) || !Number.isInteger(meta.position) || meta.position < 1 || meta.position > 2147483647) bad();
      const { client } = await getServices();
      const page = await client.history({ chatId: meta.chatId, start: meta.position, limit: 1 });
      const item = page.items?.[0];
      if (!item || item.position !== meta.position || item.id !== meta.messageId || item.resource?.key !== meta.key) denied();
      dir = await mkdtemp(join(tmpdir(), 'larkmate-transfer-'));
      const path = join(dir, 'download');
      const result = await client.downloadFile({ chatId: meta.chatId, messageId: meta.messageId, key: meta.key, output: path, maxBytes: policy.maxFileBytes });
      const size = (await stat(path)).size;
      if (size > policy.maxFileBytes || size !== result.bytes) throw new FeishuError('DOWNLOAD_INCOMPLETE', 'The downloaded file is incomplete.');
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(size), 'cache-control': 'no-store', 'connection': 'close' });
      await pipeline(createReadStream(path), res);
    }
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    const failure = dispatched && !(error instanceof FeishuError)
      ? new FeishuError('EFFECT_UNKNOWN', 'The broker could not confirm the result; inspect before retrying.') : error;
    answer(400, { ok: false, error: failure instanceof FeishuError ? { code: failure.code, message: failure.message } : { code: 'BROKER_ERROR', message: 'The file transfer failed.' } });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

function fileRequest(socketPath, token, meta) {
  return http.request({ socketPath, method: 'POST', path: '/v1/file', timeout: 120000, headers: {
    'content-type': 'application/octet-stream', authorization: `Bearer ${token}`,
    'x-larkmate-file': Buffer.from(JSON.stringify(meta)).toString('base64url'),
    ...(meta.size != null ? { 'content-length': String(meta.size) } : { 'content-length': '0' }),
  } });
}
async function errorResponse(res) {
  let data = '';
  for await (const chunk of res) { data += chunk; if (data.length > 65536) break; }
  try { const error = JSON.parse(data).error; return new FeishuError(error.code, error.message); }
  catch { return new FeishuError('BROKER_INVALID_RESPONSE', 'The broker returned an invalid response.'); }
}
export async function brokerUpload(socketPath, tokenFile, command, { chatId, path }) {
  const token = await loadBrokerToken(tokenFile);
  if (typeof path !== 'string' || !path) throw new FeishuError('FILE_UNAVAILABLE', 'Cannot open the file.');
  let handle;
  try { handle = await open(path, 'r'); } catch { throw new FeishuError('FILE_UNAVAILABLE', 'Cannot open the file.'); }
  try {
    const info = await handle.stat(), name = basename(path);
    if (!info.isFile() || info.size < 1 || info.size > MAX || !safeName(name)) throw new FeishuError('FILE_INVALID', 'Use a regular, non-empty file up to 100 MiB with a valid name.');
    const req = fileRequest(socketPath, token, { command, chatId, name, size: info.size });
    return await new Promise((resolve, reject) => {
      const source = handle.createReadStream({ autoClose: false });
      let done = false;
      const finish = (error, data) => { if (done) return; done = true; source.destroy(); error ? reject(error) : resolve(data); };
      req.on('response', async res => {
        try {
          if (res.statusCode !== 200) return finish(await errorResponse(res));
          let body = ''; for await (const chunk of res) { body += chunk; if (body.length > 65536) throw new Error(); }
          const parsed = JSON.parse(body);
          if (!parsed.ok) throw new Error();
          finish(null, parsed.data);
        } catch { finish(new FeishuError('EFFECT_UNKNOWN', 'The broker could not confirm the result; inspect before retrying.')); }
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => finish(new FeishuError('EFFECT_UNKNOWN', 'The broker connection failed; inspect the result before retrying.')));
      source.on('error', () => req.destroy());
      source.pipe(req);
    });
  } finally { await handle.close(); }
}
export async function brokerDownload(socketPath, tokenFile, { chatId, messageId, key, position, output }) {
  if (!Number.isInteger(position) || position < 1 || position > 2147483647) throw new FeishuError('INVALID_ARGUMENT', 'A message --position from history is required by the broker.');
  if (typeof output !== 'string' || !output.trim()) throw new FeishuError('INVALID_ARGUMENT', 'An output path is required.');
  const token = await loadBrokerToken(tokenFile);
  const req = fileRequest(socketPath, token, { command: 'download-file', chatId, messageId, key, position });
  return await new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, data) => { if (done) return; done = true; error ? reject(error) : resolve(data); };
    req.on('response', async res => {
      if (res.statusCode !== 200) { try { return finish(await errorResponse(res)); } catch { return finish(new FeishuError('BROKER_INVALID_RESPONSE', 'Invalid broker response.')); } }
      let file, bytes = 0;
      try {
        const length = Number(res.headers['content-length']);
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX) throw new Error('invalid length');
        try { file = await open(output, 'wx', 0o600); }
        catch (error) { res.destroy(); return finish(new FeishuError('DOWNLOAD_WRITE_FAILED', error.code === 'EEXIST' ? 'Output file already exists; choose a new path.' : 'Could not create the output file.')); }
        for await (const chunk of res) { bytes += chunk.length; if (bytes > length) throw new Error('too large'); await file.writeFile(chunk); }
        if (bytes !== length) throw new Error('incomplete');
        finish(null, { output, bytes, messageId });
      } catch { finish(new FeishuError('DOWNLOAD_INCOMPLETE', 'The download stopped; the output file is incomplete.', { output, bytes })); }
      finally { await file?.close(); }
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => finish(new FeishuError('BROKER_UNAVAILABLE', 'Cannot connect to the broker.')));
    req.end();
  });
}
