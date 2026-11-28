import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { parsePolicy } from '../src/agent-broker.js';
import { checkDelegation, loadDelegateConfig, serveOne } from '../src/os-delegate.js';

const request = (command, service, method, ...args) => ({ command, service, method, args });
const history = request('history', 'client', 'historyPages', { chatId: '123', pages: 1 });
const send = request('send', 'client', 'send', { chatId: '123', text: 'hello', mentions: [] });
const denyProfile = () => ({ policy: parsePolicy({ version: 1, allow: ['history'], chatIds: ['123'] }), approvalTimeoutSeconds: 1 });
async function runner(input, profile, getServices) {
  const chunks = [], output = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  await serveOne({ input: Readable.from(input.map(x => Buffer.from(x))), output, uid: '900', profile, getServices });
  const result = Buffer.concat(chunks), end = result.indexOf(10);
  return { header: JSON.parse(result.subarray(0, end).toString()), data: result.subarray(end + 1) };
}
async function script(dir, source) {
  const path = join(dir, 'approve');
  await writeFile(path, `#!${process.execPath}\n${source}\n`, { mode: 0o700 }); return path;
}

test('per-UID configuration is strict and only owner-controlled regular files are read', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-os-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const owner = process.getuid(), path = join(dir, 'policy.json'), caller = String(owner + 1000);
  const config = { version: 1, ownerUid: owner, credentialsFile: '/absolute/credentials.json', users: { [caller]: { policy: { version: 1, allow: ['history'], chatIds: ['123'] } } } };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual((await loadDelegateConfig(path, owner)).users[caller].policy.allow, ['history']);
  await chmod(path, 0o666); await assert.rejects(loadDelegateConfig(path, owner), { code: 'DELEGATE_CONFIG_INVALID' });
  await chmod(path, 0o600); await symlink(path, join(dir, 'link'));
  await assert.rejects(loadDelegateConfig(join(dir, 'link'), owner), { code: 'DELEGATE_CONFIG_INVALID' });
  config.users[String(owner)] = config.users[caller]; await writeFile(path, JSON.stringify(config));
  await assert.rejects(loadDelegateConfig(path, owner), { code: 'DELEGATE_CONFIG_INVALID' });
});

test('approval is per request, validates command shape, and fails closed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-os-approval-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'requests');
  const path = await script(dir, `import fs from 'node:fs'; let s=''; process.stdin.on('data',x=>s+=x).on('end',()=>{ const r=JSON.parse(s); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(r)+'\\n'); process.stdout.write(JSON.stringify({decision:'allow',requestId:r.requestId})); });`);
  const profile = { ...denyProfile(), approvalScript: path };
  await checkDelegation({ profile, uid: '900', request: history });
  await assert.rejects(readFile(log), { code: 'ENOENT' });
  await checkDelegation({ profile, uid: '900', request: send });
  await checkDelegation({ profile, uid: '900', request: request('history', 'client', 'historyPages', { chatId: '456', pages: 1 }) });
  const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2); assert.notEqual(records[0].requestId, records[1].requestId);
  assert.deepEqual(records[0].request, send); assert.equal(records[0].callerUid, 900);
  await assert.rejects(checkDelegation({ profile, uid: '900', request: request('history', 'client', 'send', { chatId: '123' }) }), { code: 'POLICY_DENIED' });
  await chmod(path, 0o777);
  await assert.rejects(checkDelegation({ profile, uid: '900', request: send }), { code: 'POLICY_DENIED' });
  await chmod(path, 0o700);
  await symlink(path, join(dir, 'approval-link'));
  await assert.rejects(checkDelegation({ profile: { ...profile, approvalScript: join(dir, 'approval-link') }, uid: '900', request: send }), { code: 'POLICY_DENIED' });
  await writeFile(path, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({decision:'allow',requestId:'wrong'}));\n`);
  await assert.rejects(checkDelegation({ profile, uid: '900', request: send }), { code: 'POLICY_DENIED' });
  await writeFile(path, `#!${process.execPath}\nsetTimeout(() => {}, 5000);\n`);
  await assert.rejects(checkDelegation({ profile, uid: '900', request: send }), { code: 'POLICY_DENIED' });
  await assert.rejects(checkDelegation({ profile: denyProfile(), uid: '900', request: send }), { code: 'POLICY_DENIED' });
});

test('single-call execution enforces policy before loading credentials and handles approved calls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-os-exec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hook = await script(dir, `let s=''; process.stdin.on('data',x=>s+=x).on('end',()=>{const r=JSON.parse(s); process.stdout.write(JSON.stringify({decision:'allow',requestId:r.requestId}));});`);
  let loads = 0, calls = 0;
  const services = async () => { loads++; return { client: { async historyPages() { return { items: [] }; }, async send(o) { calls++; return { text: o.text }; } } }; };
  let result = await runner([JSON.stringify(send) + '\n'], denyProfile(), services);
  assert.equal(result.header.error.code, 'POLICY_DENIED'); assert.equal(loads, 0);
  result = await runner([JSON.stringify(history) + '\n'], denyProfile(), services);
  assert.equal(result.header.ok, true); assert.equal(loads, 1);
  result = await runner([JSON.stringify(send) + '\n'], { ...denyProfile(), approvalScript: hook }, services);
  assert.equal(result.header.data.text, 'hello'); assert.equal(calls, 1);
  result = await runner([JSON.stringify(send) + '\n'], { ...denyProfile(), approvalScript: hook }, async () => ({ client: { async send() { throw new Error('connection lost'); } } }));
  assert.equal(result.header.error.code, 'EFFECT_UNKNOWN');
  result = await runner([JSON.stringify({ command: 'delegate-info' }) + '\n'], denyProfile(), services);
  assert.equal(result.header.data.policy.chatIds[0], '123');
});

test('file delegation hashes the received data and checks message position before download', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-os-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'request');
  const hook = await script(dir, `import fs from 'node:fs'; let s=''; process.stdin.on('data',x=>s+=x).on('end',()=>{const r=JSON.parse(s); fs.writeFileSync(${JSON.stringify(log)},s); process.stdout.write(JSON.stringify({decision:'allow',requestId:r.requestId}));});`);
  const profile = { ...denyProfile(), approvalScript: hook };
  const client = {
    async sendFile({ path }) { assert.equal(await readFile(path, 'utf8'), 'data'); return { status: 'accepted' }; },
    async history() { return { items: [{ id: '456', position: 5, resource: { key: 'valid' } }] }; },
    async downloadFile({ output }) { await writeFile(output, 'output'); return { bytes: 6 }; },
  };
  const upload = { ...request('send-file', 'files', 'upload', { chatId: '123' }), fileName: 'example.txt', size: 4 };
  let result = await runner([JSON.stringify(upload) + '\n', 'da', 'ta'], profile, async () => ({ client }));
  assert.equal(result.header.data.status, 'accepted');
  const approved = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(approved.file.size, 4); assert.equal(approved.file.sha256, createHash('sha256').update('data').digest('hex')); assert.equal(approved.file.name, 'example.txt');
  const download = request('download-file', 'files', 'download', { chatId: '123', messageId: '456', key: 'valid', position: 5 });
  result = await runner([JSON.stringify(download) + '\n'], profile, async () => ({ client }));
  assert.equal(result.header.size, 6); assert.equal(result.data.toString(), 'output');
  download.args[0].key = 'forged';
  result = await runner([JSON.stringify(download) + '\n'], profile, async () => ({ client }));
  assert.equal(result.header.error.code, 'POLICY_DENIED');
  upload.fileName = '../secret';
  result = await runner([JSON.stringify(upload) + '\ndata'], profile, async () => ({ client }));
  assert.notEqual(result.header.ok, true);
});

test('client streams a request through a single sudo invocation and preserves file contents', async t => {
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const { callOsDelegate } = await import('../src/os-delegate-client.js');
  const dir = await mkdtemp(join(tmpdir(), 'larkmate-os-client-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const helper = join(dir, 'helper.mjs'), input = join(dir, 'input.bin'), output = join(dir, 'output.bin');
  const moduleUrl = pathToFileURL(new URL('../src/os-delegate.js', import.meta.url).pathname).href;
  const policyUrl = pathToFileURL(new URL('../src/agent-broker.js', import.meta.url).pathname).href;
  await writeFile(helper, `import {serveOne} from ${JSON.stringify(moduleUrl)}; import {parsePolicy} from ${JSON.stringify(policyUrl)}; import {readFile,writeFile} from 'node:fs/promises'; const p={policy:parsePolicy({version:1,allow:['send-file','download-file'],chatIds:['123']}),approvalTimeoutSeconds:1}; const client={async sendFile({path}){return {size:(await readFile(path)).length}},async history(){return {items:[{id:'456',position:5,resource:{key:'key'}}]}},async downloadFile({output}){await writeFile(output,'contents');return {bytes:8}}}; await serveOne({input:process.stdin,output:process.stdout,uid:'900',profile:p,getServices:async()=>({client})});`);
  const bytes = Buffer.alloc(1024 * 1024 + 3, 67); await writeFile(input, bytes);
  const fakeSpawn = (executable, args, options) => {
    assert.equal(executable, '/usr/bin/sudo'); assert.deepEqual(args, ['-n', '-u', 'owner', '--', '/protected/launcher']);
    return spawn(process.execPath, [helper], options);
  };
  const upload = request('send-file', 'files', 'upload', { chatId: '123' });
  assert.equal((await callOsDelegate({ owner: 'owner', launcher: '/protected/launcher', request: upload, inputPath: input, spawnImpl: fakeSpawn })).size, bytes.length);
  const download = request('download-file', 'files', 'download', { chatId: '123', messageId: '456', position: 5, key: 'key' });
  assert.equal((await callOsDelegate({ owner: 'owner', launcher: '/protected/launcher', request: download, outputPath: output, spawnImpl: fakeSpawn })).bytes, 8);
  assert.equal(await readFile(output, 'utf8'), 'contents');
  await assert.rejects(callOsDelegate({ owner: 'owner', launcher: '/protected/launcher', request: download, outputPath: output, spawnImpl: fakeSpawn }), { code: 'DOWNLOAD_WRITE_FAILED' });
});
