import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import protobuf from 'protobufjs';
import { Gateway } from '../src/gateway.js';
import { FeishuUserClient } from '../src/client.js';
import { loadCookie } from '../src/credentials.js';

const proto = await protobuf.load(fileURLToPath(new URL('../proto/lark.proto', import.meta.url)));
const encode = (name, value) => {
  const type = proto.lookupType(name);
  return type.encode(type.fromObject(value)).finish();
};
const decode = (name, value) => proto.lookupType(name).decode(value);
const readBody = async request => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
};

async function fixture() {
  const calls = [];
  const state = { failure: null, empty: null, botReadMissing: false, name: 'Validation', description: 'Before', dissolved: false,
    protection: new Map(),
    members: new Map([['100', { id: '100', name: 'Owner', type: 1 }]]) };
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === '/csrf') {
        response.setHeader('set-cookie', ['swp_csrf_token=test-csrf; Path=/', 'sl_session=rotated; Path=/']);
        response.end('{}');
        return;
      }
      if (request.url.startsWith('/user?')) {
        assert.equal(request.headers['x-csrf-token'], 'test-csrf');
        assert.match(request.headers.cookie, /sl_session=rotated/);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: { user: { id: '100', name: 'Owner' } } }));
        return;
      }
      if (request.url.startsWith('/bot/')) {
        const action = request.url.slice('/bot/'.length);
        calls.push(action);
        const body = JSON.parse((await readBody(request)).toString());
        assert.equal(body.chat_id, '500');
        assert.equal(body.i18n, 'zh-CN');
        if (state.failure === action) {
          state.failure = null;
          response.writeHead(503).end();
          return;
        }
        if (action === 'SetBotAddConf' || action === 'UpdateAppBotInfo') {
          assert.equal(typeof body.check_mender, 'boolean');
          state.protection.set(body.bot_id, body.check_mender);
          if (action === 'SetBotAddConf') state.members.set(body.bot_id, { id: body.bot_id, name: 'Bot', type: 2 });
          response.end(JSON.stringify({ code: 0 }));
        } else if (action === 'fetch_bot_conf_resource') {
          response.end(JSON.stringify({ code: 0, ok: true, fields: state.botReadMissing ? [] : [
            { field_key: 'check_mender', field_value: String(state.protection.get(body.bot_id)) },
          ] }));
        } else response.writeHead(404).end();
        return;
      }
      assert.equal(request.url, '/gateway');
      const packet = decode('Packet', await readBody(request));
      calls.push(packet.cmd);
      if (state.failure === packet.cmd) {
        state.failure = null;
        response.writeHead(503).end();
        return;
      }
      let payload;
      if (state.empty === packet.cmd) {
        state.empty = null;
      } else if (packet.cmd === 11021) {
        const requestData = decode('UniversalSearchRequest', packet.payload);
        assert.equal(requestData.header.query, 'Dev');
        payload = encode('UniversalSearchResponse', { results: [{ id: '900', type: 2, titleHighlighted: '<em>Dev</em>' }] });
      } else if (packet.cmd === 13) {
        const requestData = decode('PutChatRequest', packet.payload);
        if (requestData.type === 1) {
          assert.deepEqual([...requestData.chatterIds], ['900']);
          payload = encode('PutChatResponse', { chat: { id: '300', type: 1, name: 'Dev' } });
        } else {
          assert.equal(requestData.type, 2);
          assert.equal(requestData.groupName, 'Validation');
          assert.deepEqual([...requestData.chatterIds], []);
          payload = encode('PutChatResponse', { chat: { id: '500', type: 2, name: 'Validation' } });
        }
      } else if (packet.cmd === 46) {
        const requestData = decode('PullChattersByIdsRequest', packet.payload);
        const types = { 100: 1, 900: 2, 901: 1, 902: 2 };
        const chatters = Object.fromEntries([...requestData.chatterIds]
          .filter(id => types[id]).map(id => [id, { id, type: types[id] }]));
        payload = encode('PullChattersByIdsResponse', { chatters });
      } else if (packet.cmd === 64) {
        const requestData = decode('PullChatsByIdsRequest', packet.payload);
        const id = requestData.chatIds[0];
        payload = encode('PullChatsByIdsResponse', { chats: { [id]: { id, type: 2, name: state.name,
          description: state.description, isDissolved: state.dissolved, lastMessagePosition: 2 } } });
      } else if (packet.cmd === 72) {
        const requestData = decode('PatchGroupChatRequest', packet.payload);
        assert.equal(requestData.chatId.toString(), '500');
        const fields = [...requestData.updateFields];
        if (fields.includes(1)) state.name = requestData.name;
        if (fields.includes(3)) state.description = requestData.description;
        if (fields.includes(16)) state.dissolved = requestData.isDissolved;
        payload = encode('PatchGroupChatResponse', { chat: { id: '500', type: 2, name: state.name,
          description: state.description, isDissolved: state.dissolved } });
      } else if (packet.cmd === 43) {
        const requestData = decode('PullMessagesByPositionsRequest', packet.payload);
        assert.equal(requestData.chatId, '500');
        assert.deepEqual([...requestData.positions], [1, 2]);
        payload = encode('PullMessagesByPositionsResponse', { messages: {
          1: { id: 'a', type: 4, position: 1, fromId: '100', content: encode('TextContent', { text: 'hello' }) },
          2: { id: 'b', type: 4, position: 2, fromId: '900', content: encode('TextContent', { text: 'ready' }) },
          999: { id: 'c', type: 4, position: 999, fromId: '900', content: encode('TextContent', { text: 'outside page' }) },
        } });
      } else if (packet.cmd === 5) {
        const requestData = decode('PutMessageRequest', packet.payload);
        assert.equal(requestData.chatId, '500');
        assert.equal(requestData.content.richText.innerText, '@Dev hello');
        assert.equal(requestData.content.richText.atIds.length, 1);
      } else if (packet.cmd === 47) {
        const requestData = decode('PutChatChatterRequest', packet.payload);
        assert.equal(requestData.chatId, '500');
        assert.deepEqual([...requestData.chatterIds], ['901']);
        state.members.set('901', { id: '901', name: 'User', type: 1 });
        payload = encode('PutChatChatterResponse', { chat: { id: '500', type: 2 } });
      } else if (packet.cmd === 44) {
        const requestData = decode('PullChatChattersRequest', packet.payload);
        assert.equal(requestData.chatId, '500');
        payload = encode('PullChatChattersResponse', { chatters: Object.fromEntries(state.members) });
      } else {
        throw new Error('unexpected mock command');
      }
      response.setHeader('content-type', 'application/x-protobuf');
      response.end(encode('Packet', { payloadType: 1, cmd: packet.cmd, ...(payload ? { payload } : {}) }));
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const gateway = new Gateway({ cookie: 'session=fixture', endpoints: {
    csrf: `${base}/csrf`, user: `${base}/user`, gateway: `${base}/gateway`, botApi: `${base}/bot/`,
  } });
  return { gateway, client: new FeishuUserClient(gateway), calls, state, close: () => new Promise(resolve => server.close(resolve)) };
}

test('user-identity requests traverse the real wire encoder and a local gateway', async t => {
  const f = await fixture();
  t.after(f.close);
  assert.deepEqual((await f.client.status()).user, { id: '100', name: 'Owner' });
  assert.deepEqual((await f.client.search('Dev')).items, [{ id: '900', type: 'bot', name: 'Dev' }]);
  assert.equal((await f.client.openChat('900')).chatId, '300');
  const created = await f.client.createGroup({ name: 'Validation', memberIds: ['900'] });
  assert.equal(created.chatId, '500');
  assert.equal(created.bots[0].status, 'verified');
  assert.equal(created.bots[0].enabled, true);
  assert.equal((await f.client.chatInfo('500')).type, 'group');
  assert.deepEqual((await f.client.history({ chatId: '500', limit: 2 })).items.map(x => x.text), ['hello', 'ready']);
  assert.equal((await f.client.invite({ chatId: '500', memberIds: ['901'] })).status, 'submitted_unconfirmed');
  assert.deepEqual((await f.client.members({ chatId: '500' })).items.map(x => x.id).sort(), ['100', '900', '901']);
  assert.equal((await f.client.send({ chatId: '500', text: '@Dev hello', mentions: [{ id: '900', name: 'Dev' }] })).status,
    'submitted_unconfirmed');
  assert.deepEqual(f.calls, [11021, 13, 46, 13, 'SetBotAddConf', 'fetch_bot_conf_resource', 64, 64, 43, 46, 47, 44, 5]);
});

test('uncertain writes are not reported as success or retried', async t => {
  const f = await fixture();
  t.after(f.close);
  f.state.failure = 13;
  await assert.rejects(f.client.createGroup({ name: 'Validation', memberIds: ['900'] }), { code: 'EFFECT_UNKNOWN' });
  assert.deepEqual(f.calls, [46, 13]);
  f.state.empty = 47;
  await assert.rejects(f.client.invite({ chatId: '500', memberIds: ['901'] }), { code: 'EFFECT_UNKNOWN' });
  assert.deepEqual(f.calls, [46, 13, 46, 47]);
});

test('bots are protected by default, explicit overrides and unverified responses remain visible', async t => {
  const f = await fixture();
  t.after(f.close);
  const first = await f.client.invite({ chatId: '500', memberIds: ['900'] });
  assert.equal(first.submitted[0].status, 'verified');
  assert.equal(first.submitted[0].enabled, true);
  assert.equal(f.state.protection.get('900'), true);
  const override = await f.client.invite({ chatId: '500', memberIds: ['902'], protectBots: false });
  assert.equal(override.submitted[0].enabled, false);
  assert.equal((await f.client.setBotProtection({ chatId: '500', botId: '902' })).enabled, true);
  f.state.botReadMissing = true;
  const unknown = await f.client.setBotProtection({ chatId: '500', botId: '902', enabled: false });
  assert.equal(unknown.status, 'submitted_unconfirmed');
  assert.equal(unknown.enabled, null);
  assert.equal(unknown.verificationError, 'PROTECTION_UNAVAILABLE');
  await assert.rejects(f.client.invite({ chatId: '500', memberIds: ['900', '999'] }), { code: 'MEMBER_TYPE_UNKNOWN' });
  assert.equal(f.calls.filter(x => x === 'SetBotAddConf').length, 2);
});

test('partial group creation reports its chat and does not repeat an uncertain bot invitation', async t => {
  const f = await fixture();
  t.after(f.close);
  f.state.failure = 'SetBotAddConf';
  await assert.rejects(f.client.createGroup({ name: 'Validation', memberIds: ['900'] }), error => {
    assert.equal(error.code, 'GROUP_CREATED_PARTIAL');
    assert.equal(error.details.chatId, '500');
    assert.equal(error.details.causeCode, 'EFFECT_UNKNOWN');
    return true;
  });
  assert.deepEqual(f.calls, [46, 13, 'SetBotAddConf']);
});

test('partial mixed invitations identify the submitted user and uncertain bot', async t => {
  const f = await fixture();
  t.after(f.close);
  f.state.failure = 'SetBotAddConf';
  await assert.rejects(f.client.invite({ chatId: '500', memberIds: ['901', '902'] }), error => {
    assert.equal(error.code, 'INVITE_PARTIAL');
    assert.deepEqual(error.details.submitted[0].memberIds, ['901']);
    assert.equal(error.details.failedBotId, '902');
    assert.equal(error.details.causeCode, 'EFFECT_UNKNOWN');
    return true;
  });
  assert.deepEqual(f.calls, [46, 47, 'SetBotAddConf']);
});

test('a created group does not claim its bot protection was verified when readback fails', async t => {
  const f = await fixture();
  t.after(f.close);
  f.state.botReadMissing = true;
  const created = await f.client.createGroup({ name: 'Validation', memberIds: ['900'] });
  assert.equal(created.status, 'created_protection_unconfirmed');
  assert.equal(created.bots[0].status, 'submitted_unconfirmed');
});

test('group edits and dissolution change only the requested fields', async t => {
  const f = await fixture();
  t.after(f.close);
  assert.equal((await f.client.chatInfo('500')).memberCount, null);
  assert.equal((await f.client.updateGroup({ chatId: '500', name: 'Renamed' })).status, 'updated');
  assert.deepEqual({ name: f.state.name, description: f.state.description }, { name: 'Renamed', description: 'Before' });
  assert.equal((await f.client.updateGroup({ chatId: '500', description: '' })).status, 'updated');
  const info = await f.client.chatInfo('500');
  assert.equal(info.name, 'Renamed');
  assert.equal(info.description, '');
  assert.equal(info.isDissolved, false);
  assert.equal((await f.client.dissolveGroup('500')).status, 'dissolved');
  assert.equal((await f.client.chatInfo('500')).isDissolved, true);
  await assert.rejects(f.client.updateGroup({ chatId: '500' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.client.updateGroup({ chatId: '500', name: ' ' }), { code: 'INVALID_ARGUMENT' });
  f.state.failure = 72;
  await assert.rejects(f.client.updateGroup({ chatId: '500', name: 'Unknown' }), { code: 'EFFECT_UNKNOWN' });
  assert.equal(f.calls.filter(x => x === 72).length, 4);
});

test('credentials reuse the existing profile without modifying or printing it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-user-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  const fixtureCookie = 'session=fake-for-test';
  const document = JSON.stringify({ active: 'a', profiles: { a: { LARK_COOKIE: fixtureCookie } } });
  await writeFile(path, document, { mode: 0o600 });
  assert.equal(await loadCookie({ file: path, env: {} }), fixtureCookie);
  assert.equal(await loadCookie({ env: { FEISHU_USER_PLUGIN_CREDENTIALS_DIR: dir }, home: dir }), fixtureCookie);
  await assert.rejects(loadCookie({ env: {}, home: dir }), { code: 'CREDENTIALS_UNAVAILABLE' });
  const { stdout } = await promisify(execFile)(process.execPath, ['bin/feishu-user.js', '--help'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { PATH: process.env.PATH, LARK_COOKIE: fixtureCookie },
  });
  assert.doesNotMatch(stdout, /fake-for-test/);
});
