import test from 'node:test';
import assert from 'node:assert/strict';
import { LarkMateClient } from '../src/client.js';
import { SessionControls } from '../src/session-controls.js';
import { authorize, parsePolicy } from '../src/agent-broker.js';

test('conversation preferences patch only requested fields and verify readback', async () => {
  const controls = new SessionControls({}); let patch;
  controls.write = async (cmd, type, body) => { patch = { cmd, type, body }; return { requestId: 'r' }; };
  controls.preferences = async () => ({ muteAtAll: true, autoTranslate: false });
  assert.equal((await controls.setPreference({ chatId: '123', muteAtAll: true })).status, 'verified');
  assert.deepEqual(patch.body, { chatId: '123', chatSetting: { isMuteAtAll: true }, updateChatSettingField: [6] });
  await assert.rejects(controls.setPreference({ chatId: '123', autoTranslate: 'true' }), { code: 'INVALID_ARGUMENT' });
});

test('contact notes with images or rich elements are not overwritten', async () => {
  const client = new LarkMateClient({});
  client.contactNote = async () => ({ description: 'old', hasImages: true, hasRichText: false });
  await assert.rejects(client.setContactNote({ userId: '456', description: 'new' }), { code: 'UNSUPPORTED_NOTE_CONTENT' });
  client.contactNote = async () => ({ description: 'old', hasImages: false, hasRichText: true });
  await assert.rejects(client.setContactNote({ userId: '456', description: 'new' }), { code: 'UNSUPPORTED_NOTE_CONTENT' });
});

test('avatar and preferences keep their target and file authorization boundaries', () => {
  const policy = parsePolicy({ version: 1, allow: ['group-avatar-set', 'chat-preferences-set', 'chat-clear-history'], chatIds: ['123'] });
  const req = (command, service, method, arg) => ({ command, service, method, args: [arg] });
  assert.doesNotThrow(() => authorize(policy, req('group-avatar-set', 'files', 'upload', { chatId: '123' })));
  assert.throws(() => authorize(policy, req('group-avatar-set', 'files', 'upload', { chatId: '123', path: '/private' })), { code: 'POLICY_DENIED' });
  assert.throws(() => authorize(policy, req('group-avatar-set', 'files', 'upload', { chatId: '999' })), { code: 'POLICY_DENIED' });
  assert.throws(() => authorize(policy, req('chat-preferences-set', 'controls', 'setPreference', { chatId: '999', autoTranslate: true })), { code: 'POLICY_DENIED' });
  assert.throws(() => authorize(policy, req('chat-preferences-set', 'controls', 'setPreference', { chatId: '123', path: '/private' })), { code: 'POLICY_DENIED' });
  assert.throws(() => authorize(policy, req('chat-clear-history', 'client', 'clearChatHistory', { chatId: '999' })), { code: 'POLICY_DENIED' });
  assert.throws(() => authorize(policy, req('chat-clear-history', 'client', 'clearChatHistory', { chatId: '123', position: 100 })), { code: 'POLICY_DENIED' });
});
