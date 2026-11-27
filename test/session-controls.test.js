import test from 'node:test';
import assert from 'node:assert/strict';
import protobuf from 'protobufjs';
import { fileURLToPath } from 'node:url';
import { SessionControls } from '../src/session-controls.js';
import { FeishuError } from '../src/errors.js';

const proto = await protobuf.load(fileURLToPath(new URL('../proto/lark.proto', import.meta.url)));
const encode = (name, value) => proto.lookupType(name).encode(proto.lookupType(name).fromObject(value)).finish();
const decode = (name, bytes) => proto.lookupType(name).decode(bytes);
const CHAT = '7000000000000000001', OTHER = '7000000000000000002', LABEL = '7000000000000000003';

function fixture() {
  const state = { pins: [{ id: OTHER, type: 1, position: 1 }], flags: [], groups: [], members: [], muted: false,
    unread: false, readPosition: 5, lastPosition: 6, feedType: 1, parent: '0', calls: [], failCommand: null, failReadback: false };
  const gateway = { decode, async call(command, request, body, opts) {
    state.calls.push({ command, mutating: opts?.mutating === true });
    const input = decode(request, encode(request, body));
    if (state.failCommand === command) { state.failCommand = null; throw new FeishuError('EFFECT_UNKNOWN', 'unknown'); }
    let data, type;
    if (command === 1103) { type = 'PullShortcutsResponse'; data = { shortcuts: state.pins, hasMore: false }; }
    else if (command === 1100) state.pins.push(...input.shortcuts.map(x => ({ id: x.id, type: x.type, position: x.position })));
    else if (command === 1101) state.pins = state.pins.filter(x => !input.shortcuts.some(y => y.id === x.id));
    else if (command === 1028) { type = 'PullFlagsResponse'; data = { items: state.flags, hasMore: false }; }
    else if (command === 1027) {
      for (const x of input.items) state.flags.push({ itemId: String(x.itemId), itemType: x.itemType, flagType: x.flagType });
      for (const x of input.deletedItems) state.flags = state.flags.filter(y => String(y.itemId) !== String(x.itemId));
    } else if (command === 1020) { type = 'PullFeedGroupsResponse'; data = { feedGroups: state.groups, hasMore: false }; }
    else if (command === 1018) { state.groups.push({ id: LABEL, type: 1, name: input.feedGroup.name }); type = 'CreateFeedGroupResponse'; data = { feedGroup: state.groups.at(-1) }; }
    else if (command === 1022) { type = 'PullFeedGroupItemsResponse'; data = { data: [{ key: String(input.args[0].key), value: { items: state.members, hasMore: false } }] }; }
    else if (command === 1023) {
      for (const g of input.feedGroups) state.groups = state.groups.map(x => x.id === String(g.id) ? { ...x, name: g.name } : x);
      for (const g of input.deletedGroups) state.groups = state.groups.filter(x => x.id !== String(g.id));
      for (const m of input.feedGroupItems) state.members.push({ feedCardId: String(m.feedCardId), feedCardType: m.feedCardType, groupId: String(m.groupId) });
      for (const m of input.deletedFeedGroupItems) state.members = state.members.filter(x => x.feedCardId !== String(m.feedCardId));
    } else if (command === 1009) {
      if (state.failReadback) throw new FeishuError('REQUEST_FAILED', 'offline');
      type = 'PullFeedCardsByIdsResponse'; data = { cards: { [CHAT]: { id: CHAT, type: 1, feedType: state.feedType, parentCardId: state.parent,
        feedCardField: { markAsUnread: { unread: state.unread } } } } };
    } else if (command === 62) { type = 'PullChatSettingsResponse'; data = { chatSettings: { [CHAT]: { isRemind: !state.muted } } }; }
    else if (command === 60) state.muted = !input.chatSetting.isRemind;
    else if (command === 64) { type = 'PullChatsByIdsResponse'; data = { chats: { [CHAT]: { id: CHAT, readPosition: state.readPosition, lastMessagePosition: state.lastPosition, lastVisibleMessagePosition: state.lastPosition, newMessageCount: state.readPosition < state.lastPosition ? 1 : 0 } } }; }
    else if (command === 1045) state.unread = input.markAsUnread;
    else if (command === 40) state.readPosition = input.maxPosition;
    else if (command === 1001) state.feedType = input.type;
    else if (command === 1006) state.parent = '123';
    else if (command === 1007) state.parent = '0';
    else throw Error(`unexpected command ${command}`);
    return { packet: type ? { payload: encode(type, data) } : {}, requestId: 'req' };
  } };
  return { state, controls: new SessionControls(gateway) };
}

test('pin and flag controls preserve unrelated entries and support reversible changes', async () => {
  const f = fixture(), c = f.controls;
  assert.equal((await c.pin(CHAT, true)).status, 'verified');
  assert.equal((await c.pin(CHAT, true)).status, 'already_set');
  assert.deepEqual((await c.pinned()).items.map(x => x.id), [OTHER, CHAT]);
  assert.equal((await c.pin(CHAT, false)).status, 'verified');
  assert.deepEqual((await c.pinned()).items.map(x => x.id), [OTHER]);
  assert.equal((await c.mark(CHAT, true)).status, 'verified');
  assert.deepEqual((await c.marked()).items.map(({ id, type }) => ({ id, type })), [{ id: CHAT, type: 'chat' }]);
  assert.equal((await c.mark(CHAT, false)).status, 'verified');
});

test('manual labels keep full 64-bit IDs through create, rename, membership and delete', async () => {
  const c = fixture().controls;
  assert.deepEqual(await c.createLabel('testing'), { status: 'verified', labelId: LABEL, requestId: 'req' });
  assert.equal((await c.renameLabel(LABEL, 'new name')).status, 'verified');
  assert.equal((await c.labelChat(LABEL, CHAT, true)).status, 'verified');
  assert.deepEqual((await c.labelChats(LABEL)).items.map(({ id, type }) => ({ id, type })), [{ id: CHAT, type: 'chat' }]);
  assert.equal((await c.labelChat(LABEL, CHAT, false)).status, 'verified');
  assert.equal((await c.deleteLabel(LABEL)).status, 'verified');
});

test('read action advances position and clears a manual unread mark', async () => {
  const f = fixture(), c = f.controls;
  assert.equal((await c.setUnread(CHAT)).status, 'verified');
  const result = await c.setRead(CHAT);
  assert.equal(result.status, 'verified');
  assert.equal(f.state.readPosition, 6);
  assert.equal(f.state.unread, false);
  assert.equal(f.state.calls.filter(x => x.command === 40).length, 1);
  assert.equal((await c.setRead(CHAT)).status, 'already_set');
});

test('mute, done and box controls read back the requested state', async () => {
  const c = fixture().controls;
  assert.equal((await c.setMute(CHAT, true)).status, 'verified');
  assert.equal((await c.setMute(CHAT, false)).status, 'verified');
  assert.equal((await c.setDone(CHAT, true)).status, 'verified');
  assert.equal((await c.setDone(CHAT, false)).status, 'verified');
  assert.equal((await c.setBox(CHAT, true)).status, 'verified');
  assert.equal((await c.setBox(CHAT, false)).status, 'verified');
});

test('uncertain writes are not retried and a failed readback never becomes verified', async () => {
  const f = fixture(); f.state.failCommand = 1100;
  await assert.rejects(f.controls.pin(CHAT, true), { code: 'EFFECT_UNKNOWN' });
  assert.equal(f.state.calls.filter(x => x.command === 1100).length, 1);
  const result = await f.controls.verified(async () => ({ requestId: 'id' }), async () => { throw new FeishuError('REQUEST_FAILED', 'offline'); });
  assert.equal(result.status, 'submitted_unconfirmed');
  assert.equal(result.verificationError, 'REQUEST_FAILED');
  await assert.rejects(f.controls.mark('not-an-id', true), { code: 'INVALID_ARGUMENT' });
});

test('empty protobuf list differs from a response without a payload', async () => {
  const empty = new SessionControls({ decode, call: async () => ({ packet: { payload: new Uint8Array(0) } }) });
  assert.deepEqual(await empty.pinned(), { items: [] });
  const absent = new SessionControls({ decode, call: async () => ({ packet: {} }) });
  await assert.rejects(absent.pinned(), { code: 'INVALID_RESPONSE' });
});

test('pinned private chats resolve missing names from the other participant', async () => {
  const gateway = { decode, async authenticate() { return { id: '100', name: 'Self' }; }, async call(command) {
    if (command === 1103) return { packet: { payload: encode('PullShortcutsResponse', { shortcuts: [{ id: CHAT, type: 1, position: 1 }], hasMore: false }) } };
    if (command === 64) return { packet: { payload: encode('PullChatsByIdsResponse', { chats: { [CHAT]: { id: CHAT, type: 1 } } }) } };
    if (command === 44) return { packet: { payload: encode('PullChatChattersResponse', { chatters: { 100: { id: '100', name: 'Self' }, 200: { id: '200', name: 'Other' } } }) } };
    throw Error('unexpected command');
  } };
  assert.equal((await new SessionControls(gateway).pinned()).items[0].name, 'Other');
});
