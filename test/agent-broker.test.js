import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, lstat, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { authorize, brokerCall, brokerProxy, createBrokerToken, loadBrokerToken, loadPolicy, parsePolicy, startBroker } from '../src/agent-broker.js';

const policy = parsePolicy({ version: 1, allow: ['history', 'messages-export', 'send', 'pin', 'minutes-export'], chatIds: ['123'], minuteTokens: ['minute_token_123'] });
const request = (command, service, method, ...args) => ({ command, service, method, args });
const token = 'a'.repeat(43);

test('policy is strict and fails closed on malformed or unsupported grants', async t => {
  assert.throws(() => parsePolicy({ version: 1, allow: ['nonexistent-file-command'] }), { code: 'POLICY_INVALID' });
  assert.throws(() => parsePolicy({ version: 1, allow: [], maxFileBytes: 0 }), { code: 'POLICY_INVALID' });
  assert.throws(() => parsePolicy({ version: 1, allow: [], maxFileBytes: 104857601 }), { code: 'POLICY_INVALID' });
  assert.throws(() => parsePolicy({ version: 1, allow: ['history'], allowAllChats: 'true' }), { code: 'POLICY_INVALID' });
  assert.throws(() => parsePolicy({ version: 1, allow: ['history'], allowAllChats: null }), { code: 'POLICY_INVALID' });
  assert.throws(() => parsePolicy({ version: 1, allow: ['history'], chatIds: null }), { code: 'POLICY_INVALID' });
  assert.throws(() => parsePolicy({ version: 1, allow: ['history'], chatIds: ['*'] }), { code: 'POLICY_INVALID' });
  assert.throws(() => parsePolicy({ version: 1, allow: ['history'], unknown: true }), { code: 'POLICY_INVALID' });
  assert.throws(() => parsePolicy({ version: 1, allow: ['history', 'history'] }), { code: 'POLICY_INVALID' });
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'policy.json');
  await writeFile(file, '{invalid');
  await assert.rejects(loadPolicy(file), { code: 'POLICY_INVALID' });
  await chmod(file, 0o666);
  await assert.rejects(loadPolicy(file), { code: 'POLICY_UNAVAILABLE' });
  await chmod(file, 0o600);
  await symlink(file, join(dir, 'policy-link'));
  await assert.rejects(loadPolicy(join(dir, 'policy-link')), { code: 'POLICY_UNAVAILABLE' });
  await assert.rejects(loadPolicy('relative.json'), { code: 'POLICY_INVALID' });
});

test('broker authorization binds operation, target, arguments and resource scope', () => {
  assert.doesNotThrow(() => authorize(policy, request('history', 'client', 'historyPages', { chatId: '123', pages: 1 })));
  assert.throws(() => authorize(policy, request('history', 'client', 'historyPages', { chatId: '124', pages: 1 })), { code: 'POLICY_DENIED' });
  assert.throws(() => authorize(policy, request('history', 'client', 'send', { chatId: '123', text: 'x' })), { code: 'POLICY_DENIED' });
  assert.throws(() => authorize(policy, request('pin', 'controls', 'pin', '123', false)), { code: 'POLICY_DENIED' });
  assert.throws(() => authorize(policy, request('send', 'client', 'send', { chatId: '123', text: 'x', replyTo: '999' })), { code: 'POLICY_DENIED' });
  assert.throws(() => authorize(policy, request('send', 'client', 'send', { chatId: '123', text: 'x', mentions: [{ id: '9', name: 'x' }] })), { code: 'POLICY_DENIED' });
  assert.throws(() => authorize(policy, request('history', 'client', 'historyPages', { chatId: '123', path: '/private' })), { code: 'POLICY_DENIED' });
  assert.doesNotThrow(() => authorize(policy, request('minutes-export', 'minutes', 'transcript', 'https://meetings.feishu.cn/minutes/minute_token_123')));
  assert.throws(() => authorize(policy, request('minutes-export', 'minutes', 'transcript', 'minute_token_456')), { code: 'POLICY_DENIED' });
  assert.throws(() => authorize(policy, request('send-file', 'client', 'sendFile', { chatId: '123', path: '/private' })), { code: 'POLICY_DENIED' });
  const scoped = parsePolicy({ version: 1, allow: ['search-messages', 'message-edit', 'reaction-add'], chatIds: ['123'], allowGlobal: true });
  assert.throws(() => authorize(scoped, request('search-messages', 'client', 'searchMessages', { query: 'x' })), { code: 'POLICY_DENIED' });
  assert.throws(() => authorize(scoped, request('message-edit', 'client', 'editMessage', { messageId: '1', text: 'x' })), { code: 'POLICY_DENIED' });
  const broad = parsePolicy({ version: 1, allow: ['reaction-add'], allowGlobal: true, allowAllChats: true });
  assert.throws(() => authorize(broad, request('reaction-add', 'client', 'reaction', { messageId: '1', emoji: 'OK', remove: true })), { code: 'POLICY_DENIED' });
});

test('Unix broker denies before loading credentials and never dispatches unsupported calls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-broker-'));
  let broker, loads = 0, calls = 0;
  t.after(async () => { if (broker) await broker.close(); await rm(dir, { recursive: true, force: true }); });
  const socket = join(dir, 'agent.sock');
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, token, { mode: 0o600 });
  broker = await startBroker({ socketPath: socket, policy, token, getServices: async () => {
    loads++;
    return { client: { async historyPages(args) { calls++; return { items: [{ text: 'allowed' }], chatId: args.chatId }; } } };
  } });
  assert.equal((await lstat(socket)).mode & 0o077, 0);
  const badTokenFile = join(dir, 'bad-token');
  await writeFile(badTokenFile, 'b'.repeat(43), { mode: 0o600 });
  await assert.rejects(brokerCall(socket, request('history', 'client', 'historyPages', { chatId: '123' }), badTokenFile), { code: 'BROKER_AUTH_FAILED' });
  await assert.rejects(brokerCall(socket, { command: 'broker-info' }, badTokenFile), { code: 'BROKER_AUTH_FAILED' });
  await assert.rejects(brokerCall(socket, request('history', 'client', 'historyPages', { chatId: '999' }), tokenFile), { code: 'POLICY_DENIED' });
  await assert.rejects(brokerCall(socket, request('history', 'client', 'constructor', { chatId: '123' }), tokenFile), { code: 'POLICY_DENIED' });
  assert.equal(loads, 0);
  const proxy = brokerProxy(socket, 'client', () => 'history', tokenFile);
  assert.equal((await proxy.historyPages({ chatId: '123' })).items[0].text, 'allowed');
  assert.equal(calls, 1);
  assert.equal(loads, 1);
  assert.deepEqual((await brokerCall(socket, { command: 'broker-info' }, tokenFile)).chatIds, ['123']);
  await assert.rejects(brokerCall(socket, request('send', 'client', 'send', { chatId: '123', text: 'x'.repeat(70000), mentions: [] }), tokenFile));
  assert.deepEqual((await brokerCall(socket, { command: 'broker-info' }, tokenFile)).chatIds, ['123']);
  await assert.rejects(startBroker({ socketPath: socket, policy, token, getServices: async () => ({}) }), { code: 'BROKER_SOCKET_EXISTS' });
  await broker.close(); broker = null;
  await assert.rejects(lstat(socket), { code: 'ENOENT' });
});

test('socket parent writable by another user is refused without deleting existing files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-parent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await chmod(dir, 0o777);
  await assert.rejects(startBroker({ socketPath: join(dir, 's'), policy, token, getServices: async () => ({}) }), { code: 'BROKER_SOCKET_INVALID' });
  await chmod(dir, 0o700);
  const file = join(dir, 'occupied');
  await writeFile(file, 'preserve');
  await assert.rejects(startBroker({ socketPath: file, policy, token, getServices: async () => ({}) }), { code: 'BROKER_SOCKET_EXISTS' });
  assert.equal(await readFile(file, 'utf8'), 'preserve');
});

test('a failed broker write is reported as an uncertain effect, not a safe retry', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-uncertain-'));
  let broker;
  t.after(async () => { if (broker) await broker.close(); await rm(dir, { recursive: true, force: true }); });
  const socket = join(dir, 'agent.sock'), tokenFile = join(dir, 'token');
  await writeFile(tokenFile, token, { mode: 0o600 });
  broker = await startBroker({ socketPath: socket, policy, token, getServices: async () => ({
    client: { async send() { throw new Error('uncertain failure after write'); } },
  }) });
  const command = request('send', 'client', 'send', { chatId: '123', text: 'hello', mentions: [] });
  await assert.rejects(brokerCall(socket, command, tokenFile), { code: 'EFFECT_UNKNOWN' });
  await broker.close(); broker = null;
  await assert.rejects(brokerCall(socket, command, tokenFile), { code: 'EFFECT_UNKNOWN' });
});

function runCli(args, env = {}) {
  const cli = fileURLToPath(new URL('../bin/larkmate.js', import.meta.url));
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', x => { stdout += x; }); proc.stderr.on('data', x => { stderr += x; });
    proc.on('error', reject); proc.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('CLI broker mode rejects denied calls without reading local credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-cli-broker-'));
  let broker;
  t.after(async () => { if (broker) await broker.close(); await rm(dir, { recursive: true, force: true }); });
  const socket = join(dir, 'agent.sock');
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, token, { mode: 0o600 });
  broker = await startBroker({ socketPath: socket, policy, token, getServices: async () => { throw new Error('must not load'); } });
  const env = { LARKMATE_BROKER: socket, LARKMATE_BROKER_TOKEN_FILE: tokenFile, LARKMATE_HOME: join(dir, 'no-credentials'), LARKMATE_COOKIE: '' };
  const info = await runCli(['broker-info'], env);
  assert.equal(info.code, 0);
  assert.deepEqual(JSON.parse(info.stdout).allow, policy.allow);
  const denied = await runCli(['history', '--chat', '999'], env);
  assert.notEqual(denied.code, 0);
  assert.equal(JSON.parse(denied.stderr).error.code, 'POLICY_DENIED');
  const localPath = join(dir, 'input.txt');
  await writeFile(localPath, 'test');
  const localFile = await runCli(['send-file', '--chat', '123', '--file', localPath], env);
  assert.equal(JSON.parse(localFile.stderr).error.code, 'POLICY_DENIED');
  const incompleteConfig = await runCli(['history', '--chat', '123'], { ...env, LARKMATE_BROKER: '', LARKMATE_COOKIE: 'not-used' });
  assert.equal(JSON.parse(incompleteConfig.stderr).error.code, 'BROKER_CONFIGURATION_INVALID');
});

test('token generation is private, non-overwriting, and rejects unsafe owner permissions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-token-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'token');
  await createBrokerToken(path);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.match(await loadBrokerToken(path, { owner: true }), /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(createBrokerToken(path), { code: 'BROKER_TOKEN_WRITE_FAILED' });
  await symlink(path, join(dir, 'token-link'));
  await assert.rejects(loadBrokerToken(join(dir, 'token-link'), { owner: true }), { code: 'BROKER_TOKEN_UNAVAILABLE' });
  await chmod(path, 0o666);
  await assert.rejects(loadBrokerToken(path, { owner: true }), { code: 'BROKER_TOKEN_UNAVAILABLE' });
});

test('broker streams files without accepting owner paths and verifies the downloaded message', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-file-broker-'));
  let broker, uploads = 0, downloads = 0;
  t.after(async () => { if (broker) await broker.close(); await rm(dir, { recursive: true, force: true }); });
  const socket = join(dir, 's'), tokenFile = join(dir, 'token'), input = join(dir, 'input.txt');
  await writeFile(tokenFile, token, { mode: 0o600 });
  await writeFile(input, 'hello');
  const filePolicy = parsePolicy({ version: 1, allow: ['send-file', 'send-image', 'download-file'], chatIds: ['123'], maxFileBytes: 8 });
  broker = await startBroker({ socketPath: socket, policy: filePolicy, token, getServices: async () => ({ client: {
    async sendFile({ chatId, path }) {
      uploads++;
      assert.equal(chatId, '123'); assert.notEqual(path, input);
      assert.equal(await readFile(path, 'utf8'), 'hello');
      assert.equal((await lstat(path)).mode & 0o077, 0);
      return { status: 'accepted', fileName: 'input.txt' };
    },
    async history({ chatId, start }) {
      assert.equal(chatId, '123');
      return { items: start === 5 ? [{ position: 5, id: '456', resource: { key: 'valid-key' } }] : [] };
    },
    async downloadFile({ output, maxBytes }) {
      downloads++; assert.equal(maxBytes, 8);
      await writeFile(output, 'result', { flag: 'wx' }); return { bytes: 6 };
    },
  } }) });
  const upload = brokerProxy(socket, 'client', () => 'send-file', tokenFile);
  const download = brokerProxy(socket, 'client', () => 'download-file', tokenFile);
  assert.equal((await upload.sendFile({ chatId: '123', path: input })).status, 'accepted');
  assert.equal(uploads, 1);
  await assert.rejects(upload.sendFile({ chatId: '999', path: input }), { code: 'POLICY_DENIED' });
  await assert.rejects(brokerCall(socket, request('send-file', 'files', 'upload', { chatId: '123' }), tokenFile), { code: 'POLICY_DENIED' });
  await assert.rejects(brokerCall(socket, request('send-file', 'files', 'upload', { chatId: '123', path: '/private' }), tokenFile), { code: 'POLICY_DENIED' });
  const output = join(dir, 'output.txt');
  await assert.rejects(download.downloadFile({ chatId: '123', messageId: '456', key: 'valid-key', output }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(download.downloadFile({ chatId: '123', messageId: '999', key: 'valid-key', position: 5, output }), { code: 'POLICY_DENIED' });
  await assert.rejects(download.downloadFile({ chatId: '123', messageId: '456', key: 'wrong-key', position: 5, output }), { code: 'POLICY_DENIED' });
  await assert.rejects(download.downloadFile({ chatId: '999', messageId: '456', key: 'valid-key', position: 5, output }), { code: 'POLICY_DENIED' });
  assert.equal(downloads, 0);
  assert.equal((await download.downloadFile({ chatId: '123', messageId: '456', key: 'valid-key', position: 5, output })).bytes, 6);
  assert.equal(await readFile(output, 'utf8'), 'result');
  await assert.rejects(download.downloadFile({ chatId: '123', messageId: '456', key: 'valid-key', position: 5, output }), { code: 'DOWNLOAD_WRITE_FAILED' });
  await writeFile(input, 'too large');
  await assert.rejects(upload.sendFile({ chatId: '123', path: input }), { code: 'INVALID_REQUEST' });
});

test('file endpoint rejects forged paths, wrong tokens and oversized input before privileged services', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-file-attack-'));
  let broker, loads = 0;
  t.after(async () => { if (broker) await broker.close(); await rm(dir, { recursive: true, force: true }); });
  const socket = join(dir, 's');
  const filePolicy = parsePolicy({ version: 1, allow: ['send-file'], chatIds: ['123'], maxFileBytes: 8 });
  broker = await startBroker({ socketPath: socket, policy: filePolicy, token, getServices: async () => { loads++; throw new Error('must not load'); } });
  const raw = (meta, auth = token) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, method: 'POST', path: '/v1/file', headers: {
      authorization: `Bearer ${auth}`, 'content-type': 'application/octet-stream',
      'x-larkmate-file': Buffer.from(JSON.stringify(meta)).toString('base64url'),
    } }, res => { let s = ''; res.on('data', c => s += c); res.on('end', () => resolve(JSON.parse(s).error.code)); });
    req.on('error', reject); req.end('x');
  });
  const input = { command: 'send-file', chatId: '123', name: 'ok.txt', size: 1 };
  assert.equal(await raw(input, 'b'.repeat(43)), 'BROKER_AUTH_FAILED');
  assert.equal(await raw({ ...input, name: '../../private' }), 'INVALID_REQUEST');
  assert.equal(await raw({ ...input, name: '..\\private' }), 'INVALID_REQUEST');
  assert.equal(await raw({ ...input, path: '/private' }), 'INVALID_REQUEST');
  assert.equal(await raw({ ...input, chatId: '999' }), 'POLICY_DENIED');
  assert.equal(await raw({ ...input, size: 9 }), 'INVALID_REQUEST');
  assert.equal(await raw({ ...input, size: 2 }), 'INVALID_REQUEST');
  assert.equal(loads, 0);
});

test('broker transfers a multi-chunk file with byte-for-byte integrity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-file-stream-'));
  let broker;
  t.after(async () => { if (broker) await broker.close(); await rm(dir, { recursive: true, force: true }); });
  const socket = join(dir, 's'), tokenFile = join(dir, 'token'), input = join(dir, 'input.bin'), output = join(dir, 'output.bin');
  const bytes = Buffer.alloc(1024 * 1024 + 7); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  await writeFile(tokenFile, token, { mode: 0o600 }); await writeFile(input, bytes);
  const filePolicy = parsePolicy({ version: 1, allow: ['send-file', 'download-file'], chatIds: ['123'], maxFileBytes: bytes.length });
  broker = await startBroker({ socketPath: socket, policy: filePolicy, token, getServices: async () => ({ client: {
    async sendFile({ path }) { assert.deepEqual(await readFile(path), bytes); return { status: 'accepted' }; },
    async history() { return { items: [{ id: '456', position: 5, resource: { key: 'valid-key' } }] }; },
    async downloadFile({ output: path }) { await writeFile(path, bytes, { flag: 'wx' }); return { bytes: bytes.length }; },
  } }) });
  const proxy = brokerProxy(socket, 'client', () => 'send-file', tokenFile);
  assert.equal((await proxy.sendFile({ chatId: '123', path: input })).status, 'accepted');
  const downloaded = await proxy.downloadFile({ chatId: '123', messageId: '456', key: 'valid-key', position: 5, output });
  assert.equal(downloaded.bytes, bytes.length);
  assert.deepEqual(await readFile(output), bytes);
});
