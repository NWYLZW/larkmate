import { constants } from 'node:fs';
import { open, stat, lstat, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { FeishuError } from './errors.js';
import { authorize, brokerCommands, parsePolicy } from './agent-broker.js';

const MAX_HEADER = 65536, MAX_FILE = 100 * 1024 * 1024;
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const only = (x, keys) => obj(x) && Object.keys(x).every(k => keys.includes(k));
const fail = (code, message) => { throw new FeishuError(code, message); };
const invalid = () => fail('DELEGATE_CONFIG_INVALID', 'Invalid OS delegation configuration.');
const noAccess = () => fail('POLICY_DENIED', 'This operation is not permitted.');
const nameOk = name => typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) <= 200 && name !== '.' && name !== '..' && !/[\/\\\x00-\x1f\x7f]/.test(name);
const uint = x => typeof x === 'string' && /^(0|[1-9]\d*)$/.test(x) && Number.isSafeInteger(Number(x));

export async function loadDelegateConfig(path, ownerUid) {
  if (!isAbsolute(path)) invalid();
  let h, raw;
  try {
    h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await h.stat();
    if (!info.isFile() || info.size > 262144 || ![0, ownerUid].includes(info.uid) || (info.mode & 0o022)) throw new Error();
    raw = JSON.parse(await h.readFile('utf8'));
  } catch { return invalid(); } finally { await h?.close(); }
  if (!only(raw, ['version', 'ownerUid', 'credentialsFile', 'users']) || raw.version !== 1 || raw.ownerUid !== ownerUid || !isAbsolute(raw.credentialsFile || '') || !obj(raw.users)) invalid();
  const users = {};
  for (const [uid, v] of Object.entries(raw.users)) {
    if (!uint(uid) || Number(uid) === ownerUid || !only(v, ['policy', 'approvalScript', 'approvalTimeoutSeconds'])) invalid();
    const policy = parsePolicy(v.policy);
    const approvalScript = v.approvalScript;
    if (approvalScript !== undefined && (typeof approvalScript !== 'string' || !isAbsolute(approvalScript))) invalid();
    const timeout = v.approvalTimeoutSeconds ?? 300;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) invalid();
    users[uid] = { policy, approvalScript, approvalTimeoutSeconds: timeout };
  }
  return { credentialsFile: raw.credentialsFile, users };
}

function broadPolicy(request, maxFileBytes) {
  return parsePolicy({ version: 1, allow: [request.command], allowGlobal: true, allowAllChats: true, allowAllMinutes: true, maxFileBytes });
}

async function approve(script, uid, request, payload, timeout) {
  let info;
  try { info = await lstat(script); } catch { noAccess(); }
  if (!info.isFile() || ![0, process.getuid()].includes(info.uid) || (info.mode & 0o022) || !(info.mode & 0o111)) noAccess();
  const requestId = randomUUID();
  const data = JSON.stringify({ version: 1, requestId, callerUid: Number(uid), request, ...(payload ? { file: payload } : {}) });
  return await new Promise(resolve => {
    const child = spawn(script, [], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME || '/', LANG: 'C.UTF-8' } });
    let text = '', finished = false;
    const done = yes => { if (finished) return; finished = true; clearTimeout(timer); resolve(yes); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(false); }, timeout * 1000);
    child.on('error', () => done(false));
    child.stdin.on('error', () => done(false));
    child.stdout.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 8192) { child.kill('SIGKILL'); done(false); } });
    child.on('close', code => {
      try { const result = JSON.parse(text); done(code === 0 && only(result, ['decision', 'requestId']) && result.decision === 'allow' && result.requestId === requestId); }
      catch { done(false); }
    });
    child.stdin.end(data + '\n');
  });
}

export async function checkDelegation({ profile, uid, request, file }) {
  if (!profile || !obj(request)) noAccess();
  // Validate the operation and its argument shape even when a hook may approve it.
  const wide = broadPolicy(request, profile.policy.maxFileBytes);
  authorize(wide, request);
  try { authorize(profile.policy, request); return; }
  catch (error) { if (!(error instanceof FeishuError) || error.code !== 'POLICY_DENIED') throw error; }
  if (!profile.approvalScript || !await approve(profile.approvalScript, uid, request, file, profile.approvalTimeoutSeconds)) noAccess();
}

export async function invokeDelegated({ profile, uid, request, getServices, filePath }) {
  const fileOp = ['send-file', 'send-image', 'download-file'].includes(request?.command);
  if (fileOp && request.service !== 'files') noAccess();
  if (!fileOp && request.service === 'files') noAccess();
  let file;
  if (request.command === 'send-file' || request.command === 'send-image') {
    if (!filePath || !nameOk(request.fileName)) fail('INVALID_REQUEST', 'Invalid file transfer.');
    const info = await stat(filePath);
    if (!info.isFile() || info.size < 1 || info.size > profile.policy.maxFileBytes || (request.command === 'send-image' && info.size > 10 * 1024 * 1024)) fail('FILE_TOO_LARGE', 'The file exceeds the configured limit.');
    const hash = createHash('sha256'); for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    file = { name: request.fileName, size: info.size, sha256: hash.digest('hex') };
  }
  // fileName is transfer metadata, not a service argument.
  const { fileName, ...rpc } = request;
  if (rpc.command === 'download-file') {
    const o = rpc.args?.[0];
    if (!only(o, ['chatId', 'messageId', 'key', 'position']) || !Number.isInteger(o.position) || o.position < 1 || o.position > 2147483647 || typeof o.messageId !== 'string' || typeof o.key !== 'string') fail('INVALID_REQUEST', 'A valid message position and resource are required.');
  }
  await checkDelegation({ profile, uid, request: rpc, file });
  const { service, method, args } = authorize(broadPolicy(rpc, profile.policy.maxFileBytes), rpc);
  const services = await getServices();
  if (service !== 'files') {
    try { return { data: await services[service][method](...args) }; }
    catch (error) {
      if (!(error instanceof FeishuError) && brokerCommands().find(x => x.command === rpc.command)?.mutating) fail('EFFECT_UNKNOWN', 'The delegated write could not be confirmed; inspect before retrying.');
      throw error;
    }
  }
  const client = services.client, o = args[0];
  if (method === 'upload') {
    try { return { data: await client[rpc.command === 'send-file' ? 'sendFile' : 'sendImage']({ chatId: o.chatId, path: filePath }) }; }
    catch (error) { if (!(error instanceof FeishuError)) fail('EFFECT_UNKNOWN', 'The delegated write could not be confirmed; inspect before retrying.'); throw error; }
  }
  return { download: true, client, options: o };
}

// The privileged helper parses one framed request and terminates; it never opens a listening socket.
export async function serveOne({ input, output, uid, profile, getServices }) {
  let temp, header = Buffer.alloc(0), received = 0, path, file, request, expected = 0, outcome, started = false;
  try {
    for await (const chunk of input) {
      let data = chunk;
      if (!request) {
        header = Buffer.concat([header, data]);
        const end = header.indexOf(10);
        if (end < 0) { if (header.length > MAX_HEADER) fail('INVALID_REQUEST', 'Request is too large.'); continue; }
        if (end > MAX_HEADER) fail('INVALID_REQUEST', 'Request is too large.');
        try { request = JSON.parse(header.subarray(0, end).toString('utf8')); } catch { fail('INVALID_REQUEST', 'Invalid request.'); }
        data = header.subarray(end + 1); header = null;
        if (!only(request, ['command', 'service', 'method', 'args', 'fileName', 'size'])) fail('INVALID_REQUEST', 'Invalid request.');
        const upload = request.command === 'send-file' || request.command === 'send-image';
        if (upload) {
          if (!nameOk(request.fileName) || !Number.isSafeInteger(request.size) || request.size < 1 || request.size > profile.policy.maxFileBytes || request.size > MAX_FILE) fail('FILE_TOO_LARGE', 'The file exceeds the configured limit.');
          const { size, fileName, ...rpc } = request;
          authorize(broadPolicy(rpc, profile.policy.maxFileBytes), rpc);
          if (!profile.approvalScript) authorize(profile.policy, rpc);
          expected = request.size;
          temp = await mkdtemp(join(tmpdir(), 'larkmate-os-transfer-'));
          path = join(temp, request.fileName); file = await open(path, 'wx', 0o600);
        } else if (Object.hasOwn(request, 'size') || Object.hasOwn(request, 'fileName')) fail('INVALID_REQUEST', 'Invalid request.');
      }
      received += data.length;
      if (received > expected) fail('INVALID_REQUEST', 'Invalid request body.');
      if (data.length) await file.writeFile(data);
    }
    if (!request || received !== expected) fail('INVALID_REQUEST', 'Incomplete request.');
    await file?.close(); file = null;
    if (only(request, ['command']) && request.command === 'delegate-info') {
      output.write(JSON.stringify({ ok: true, data: { policy: profile.policy, approvalConfigured: !!profile.approvalScript } }) + '\n');
      return;
    }
    const { size, ...rpc } = request;
    outcome = await invokeDelegated({ profile, uid, request: rpc, getServices, filePath: path });
    if (!outcome.download) { output.write(JSON.stringify({ ok: true, data: outcome.data }) + '\n'); return; }
    const o = outcome.options;
    if (!only(o, ['chatId', 'messageId', 'key', 'position']) || !Number.isInteger(o.position) || o.position < 1 || o.position > 2147483647 || typeof o.messageId !== 'string' || typeof o.key !== 'string') fail('INVALID_REQUEST', 'A valid message position and resource are required.');
    const page = await outcome.client.history({ chatId: o.chatId, start: o.position, limit: 1 });
    const item = page.items?.[0];
    if (!item || item.position !== o.position || item.id !== o.messageId || item.resource?.key !== o.key) noAccess();
    temp = await mkdtemp(join(tmpdir(), 'larkmate-os-transfer-')); path = join(temp, 'download');
    const result = await outcome.client.downloadFile({ chatId: o.chatId, messageId: o.messageId, key: o.key, output: path, maxBytes: profile.policy.maxFileBytes });
    const info = await stat(path);
    if (info.size !== result.bytes || info.size > profile.policy.maxFileBytes) fail('DOWNLOAD_INCOMPLETE', 'The downloaded file is incomplete.');
    output.write(JSON.stringify({ ok: true, size: info.size }) + '\n');
    started = true;
    for await (const chunk of createReadStream(path)) if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
  } catch (error) {
    if (started) { output.destroy(); return; }
    const result = error instanceof FeishuError ? { code: error.code, message: error.message } : { code: 'DELEGATE_ERROR', message: 'The delegated operation failed.' };
    output.write(JSON.stringify({ ok: false, error: result }) + '\n');
  } finally { await file?.close(); if (temp) await rm(temp, { recursive: true, force: true }); }
}

export function osDelegateInfo() { return brokerCommands(); }
