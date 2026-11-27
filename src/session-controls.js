import { FeishuError, requireNumericId, requireText } from './errors.js';
import { LarkMateClient } from './client.js';

const VERSION = '5.7.0';
const own = (value, field) => value != null && Object.hasOwn(value, field);
const str = value => value == null ? null : String(value);
function numeric(value, label) {
  requireNumericId(value, label);
  if (BigInt(value) < 1n || BigInt(value) > 9223372036854775807n) throw new FeishuError('INVALID_ARGUMENT', `${label} is outside the supported range.`);
  return value;
}

export class SessionControls {
  constructor(gateway) { this.gateway = gateway; }

  async read(cmd, req, body, response) {
    const result = await this.gateway.call(cmd, req, body, { version: VERSION, operation: req });
    if (!own(result.packet, 'payload') || !result.packet.payload) throw new FeishuError('INVALID_RESPONSE', `${req} returned no readable page.`);
    try { return this.gateway.decode(response, result.packet.payload); }
    catch { throw new FeishuError('INVALID_RESPONSE', `${req} returned an unreadable page.`); }
  }

  async write(cmd, req, body) {
    return this.gateway.call(cmd, req, body, { version: VERSION, mutating: true, operation: req });
  }

  async verified(write, verify) {
    const result = await write();
    try {
      return { status: await verify() ? 'verified' : 'submitted_unconfirmed', requestId: result.requestId };
    } catch (error) {
      return { status: 'submitted_unconfirmed', requestId: result.requestId, verificationError: error.code || 'READBACK_FAILED' };
    }
  }

  async describe(items) {
    const types = { 1: 'p2p', 2: 'group', 3: 'topic_group' };
    const result = [];
    for (let i = 0; i < items.length; i += 20) {
      const batch = items.slice(i, i + 20);
      let chats = {};
      try { chats = (await this.read(64, 'PullChatsByIdsRequest', { chatIds: batch.map(x => x.id) }, 'PullChatsByIdsResponse')).chats; }
      catch { /* The list remains useful when chat metadata is unavailable. */ }
      result.push(...batch.map(item => ({ ...item, name: chats[item.id]?.name || null,
        chatType: types[chats[item.id]?.type] || 'unknown' })));
    }
    const missing = result.filter(x => x.chatType === 'p2p' && !x.name);
    if (missing.length) {
      try {
        const self = await this.gateway.authenticate();
        const client = new LarkMateClient(this.gateway);
        for (const item of missing) {
          try {
            const members = (await client.members({ chatId: item.id, limit: 20 })).items;
            const other = members.find(member => member.id !== self.id && member.name);
            item.name = other?.name || (members.length === 1 && members[0].id === self.id ? self.name : null) || null;
          } catch { /* Metadata is optional; the conversation ID remains available. */ }
        }
      } catch { /* Leave unknown names empty. */ }
    }
    return result;
  }

  async pinned({ details = true } = {}) {
    const items = [], seen = new Set(); let position = 0;
    for (let i = 0; i < 100; i++) {
      const p = await this.read(1103, 'PullShortcutsRequest', { position, count: 50 }, 'PullShortcutsResponse');
      items.push(...p.shortcuts.map(x => ({ id: x.id, type: x.type, position: x.position })));
      if (!p.hasMore) { const chats = items.filter(x => x.type === 1); return { items: details ? await this.describe(chats) : chats }; }
      const next = Math.max(position, ...p.shortcuts.map(x => x.position));
      if (next <= position || seen.has(next)) break;
      seen.add(next); position = next;
    }
    throw new FeishuError('PAGINATION_INCOMPLETE', 'Unable to read the entire pinned list.');
  }

  async pin(chatId, enabled) {
    numeric(chatId, 'chat ID'); const before = (await this.pinned({ details: false })).items; const item = before.find(x => x.id === chatId);
    if (!!item === enabled) return { status: 'already_set', chatId, pinned: enabled };
    const position = enabled ? Math.max(0, ...before.map(x => x.position)) + 1 : item.position;
    if (position > 2147483647) throw new FeishuError('INVALID_RESPONSE', 'The pinned list position is invalid.');
    const result = await this.verified(
      () => this.write(enabled ? 1100 : 1101, enabled ? 'PutShortcutsRequest' : 'DeleteShortcutsRequest', { shortcuts: [{ id: chatId, type: 1, position }] }),
      async () => (await this.pinned({ details: false })).items.some(x => x.id === chatId) === enabled,
    );
    return { ...result, chatId, pinned: enabled };
  }

  async marked({ details = true } = {}) {
    const items = [], seen = new Set(); let cursor = '';
    for (let i = 0; i < 100; i++) {
      const p = await this.read(1028, 'PullFlagsRequest', { cursor, count: 50 }, 'PullFlagsResponse');
      items.push(...p.items.filter(x => x.flagType === 1 && x.itemType === 1).map(x => ({ id: str(x.itemId), type: 'chat' })));
      if (!p.hasMore) return { items: details ? await this.describe(items) : items };
      if (!p.nextCursor || seen.has(p.nextCursor)) break;
      seen.add(p.nextCursor); cursor = p.nextCursor;
    }
    throw new FeishuError('PAGINATION_INCOMPLETE', 'Unable to read the entire marked list.');
  }

  async mark(chatId, enabled) {
    numeric(chatId, 'chat ID'); const before = (await this.marked({ details: false })).items.some(x => x.id === chatId);
    if (before === enabled) return { status: 'already_set', chatId, marked: enabled };
    const body = { [enabled ? 'items' : 'deletedItems']: [{ itemId: chatId, itemType: 1, flagType: 1 }] };
    const result = await this.verified(() => this.write(1027, 'UpdateFlagsRequest', body),
      async () => (await this.marked({ details: false })).items.some(x => x.id === chatId) === enabled);
    return { ...result, chatId, marked: enabled };
  }

  async labels() {
    const items = [], seen = new Set(); let cursor = '';
    for (let i = 0; i < 100; i++) {
      const p = await this.read(1020, 'PullFeedGroupsRequest', { cursor, count: 20, isRebuilding: false, version: 1 }, 'PullFeedGroupsResponse');
      if (p.needRebuilding) throw new FeishuError('LABELS_REBUILDING', 'Labels are being rebuilt; retry the read later.');
      items.push(...p.feedGroups.map(x => ({ id: str(x.id), name: x.name, type: x.type, isDefault: x.isDefault })));
      if (!p.hasMore) return { items };
      if (!p.nextCursor || seen.has(p.nextCursor)) break;
      seen.add(p.nextCursor); cursor = p.nextCursor;
    }
    throw new FeishuError('PAGINATION_INCOMPLETE', 'Unable to read all labels.');
  }

  async label(labelId) {
    numeric(labelId, 'label ID'); const label = (await this.labels()).items.find(x => x.id === labelId);
    if (!label) throw new FeishuError('NOT_FOUND', 'The label was not found.');
    return label;
  }

  async labelChats(labelId, { details = true } = {}) {
    numeric(labelId, 'label ID'); const items = [], seen = new Set(); let cursor = '';
    for (let i = 0; i < 100; i++) {
      const p = await this.read(1022, 'PullFeedGroupItemsRequest', { args: [{ key: labelId, value: { cursor, count: 20, isRebuilding: false } }] }, 'PullFeedGroupItemsResponse');
      const page = p.data.find(x => str(x.key) === labelId)?.value;
      if (!page) throw new FeishuError('INVALID_RESPONSE', 'The requested label page was absent.');
      if (page.needRebuilding) throw new FeishuError('LABELS_REBUILDING', 'Label members are being rebuilt; retry the read later.');
      items.push(...page.items.filter(x => x.feedCardType === 1 && !x.exclude).map(x => ({ id: str(x.feedCardId), type: 'chat' })));
      if (!page.hasMore) return { labelId, items: details ? await this.describe(items) : items };
      if (!page.nextCursor || seen.has(page.nextCursor)) break;
      seen.add(page.nextCursor); cursor = page.nextCursor;
    }
    throw new FeishuError('PAGINATION_INCOMPLETE', 'Unable to read all label members.');
  }

  async createLabel(name) {
    requireText(name, 'label name');
    const result = await this.write(1018, 'CreateFeedGroupRequest', { feedGroup: { type: 1, name } });
    let labelId = null;
    try { labelId = str(this.gateway.decode('CreateFeedGroupResponse', result.packet.payload).feedGroup?.id); } catch { /* preserve unknown result */ }
    if (!labelId || labelId === '0') return { status: 'submitted_unconfirmed', requestId: result.requestId };
    try {
      const label = (await this.labels()).items.find(x => x.id === labelId && x.name === name);
      return { status: label ? 'verified' : 'submitted_unconfirmed', labelId, requestId: result.requestId };
    } catch (error) { return { status: 'submitted_unconfirmed', labelId, requestId: result.requestId, verificationError: error.code || 'READBACK_FAILED' }; }
  }

  async renameLabel(labelId, name) {
    requireText(name, 'label name'); const before = await this.label(labelId);
    if (before.name === name) return { status: 'already_set', labelId, name };
    const result = await this.verified(() => this.write(1023, 'UpdateFeedGroupsRequest', {
      feedGroups: [{ id: labelId, type: before.type, name }], feedGroupsUpdateFields: [{ key: labelId, value: { fields: [1] } }],
    }), async () => (await this.labels()).items.some(x => x.id === labelId && x.name === name));
    return { ...result, labelId, name };
  }

  async deleteLabel(labelId) {
    const label = await this.label(labelId);
    const result = await this.verified(() => this.write(1023, 'UpdateFeedGroupsRequest', { deletedGroups: [{ id: labelId, type: label.type, name: label.name }] }),
      async () => !(await this.labels()).items.some(x => x.id === labelId));
    return { ...result, labelId };
  }

  async labelChat(labelId, chatId, enabled) {
    numeric(chatId, 'chat ID'); const label = await this.label(labelId);
    if (label.type !== 1) throw new FeishuError('UNSUPPORTED_LABEL_TYPE', 'Only manually managed labels are supported.');
    const before = (await this.labelChats(labelId, { details: false })).items.some(x => x.id === chatId);
    if (before === enabled) return { status: 'already_set', labelId, chatId, included: enabled };
    const key = enabled ? 'feedGroupItems' : 'deletedFeedGroupItems';
    const result = await this.verified(() => this.write(1023, 'UpdateFeedGroupsRequest', { [key]: [{ feedCardId: chatId, feedCardType: 1, groupId: labelId }] }),
      async () => (await this.labelChats(labelId, { details: false })).items.some(x => x.id === chatId) === enabled);
    return { ...result, labelId, chatId, included: enabled };
  }

  async card(chatId) {
    numeric(chatId, 'chat ID'); const p = await this.read(1009, 'PullFeedCardsByIdsRequest', { feedCardIdentities: [{ id: chatId, type: 1 }] }, 'PullFeedCardsByIdsResponse');
    const card = p.cards[chatId]; if (!card) throw new FeishuError('NOT_FOUND', 'The conversation card was not found.');
    return card;
  }

  async chat(chatId) {
    numeric(chatId, 'chat ID'); const p = await this.read(64, 'PullChatsByIdsRequest', { chatIds: [chatId] }, 'PullChatsByIdsResponse');
    const chat = p.chats[chatId]; if (!chat) throw new FeishuError('NOT_FOUND', 'The conversation was not found.');
    return chat;
  }

  async muted(chatId) {
    numeric(chatId, 'chat ID'); const p = await this.read(62, 'PullChatSettingsRequest', { chatIds: [chatId] }, 'PullChatSettingsResponse');
    const x = p.chatSettings[chatId]; if (!own(x, 'isRemind')) throw new FeishuError('STATE_UNAVAILABLE', 'Notification settings were not returned.');
    return !x.isRemind;
  }

  async setMute(chatId, enabled) {
    const before = await this.muted(chatId);
    if (before === enabled) return { status: 'already_set', chatId, muted: enabled };
    const result = await this.verified(() => this.write(60, 'PatchChatSettingRequest', {
      chatId, chatSetting: { isRemind: !enabled }, updateChatSettingField: [1],
    }), async () => await this.muted(chatId) === enabled);
    return { ...result, chatId, muted: enabled };
  }

  async setUnread(chatId) {
    const card = await this.card(chatId);
    if (card.feedCardField?.markAsUnread?.unread === true) return { status: 'already_set', chatId, manualUnread: true };
    const result = await this.verified(() => this.write(1045, 'PatchFeedCardUnreadRequest', { card: { id: chatId, type: 1 }, markAsUnread: true }),
      async () => (await this.card(chatId)).feedCardField?.markAsUnread?.unread === true);
    return { ...result, chatId, manualUnread: true };
  }

  async setRead(chatId) {
    const [chat, card] = await Promise.all([this.chat(chatId), this.card(chatId)]);
    const maxPosition = own(chat, 'lastVisibleMessagePosition') ? chat.lastVisibleMessagePosition : chat.lastMessagePosition;
    if (!Number.isInteger(maxPosition) || maxPosition < 0) throw new FeishuError('POSITION_UNAVAILABLE', 'The latest message position was not returned.');
    const marked = card.feedCardField?.markAsUnread?.unread === true;
    if (own(chat, 'readPosition') && chat.readPosition >= maxPosition && !marked) return { status: 'already_set', chatId, readThrough: maxPosition };
    const result = await this.write(40, 'PutReadMessagesRequest', { chatId, maxPosition });
    if (marked) {
      try { await this.write(1045, 'PatchFeedCardUnreadRequest', { card: { id: chatId, type: 1 }, markAsUnread: false }); }
      catch (error) { throw new FeishuError('PARTIAL_EFFECT', 'Read position was submitted but the manual unread marker could not be cleared.', { chatId, requestId: result.requestId, causeCode: error.code || 'UNKNOWN' }); }
    }
    try {
      const [after, feed] = await Promise.all([this.chat(chatId), this.card(chatId)]);
      const verified = own(after, 'readPosition') && after.readPosition >= maxPosition && feed.feedCardField?.markAsUnread?.unread !== true;
      return { status: verified ? 'verified' : 'submitted_unconfirmed', chatId, readThrough: maxPosition, requestId: result.requestId };
    } catch (error) { return { status: 'submitted_unconfirmed', chatId, readThrough: maxPosition, requestId: result.requestId, verificationError: error.code || 'READBACK_FAILED' }; }
  }

  async setDone(chatId, enabled) {
    const card = await this.card(chatId); const target = enabled ? 2 : 1;
    if (card.feedType === target) return { status: 'already_set', chatId, done: enabled };
    const result = await this.verified(() => this.write(1001, 'PatchFeedCardsRequest', { type: target, ids: [chatId] }),
      async () => (await this.card(chatId)).feedType === target);
    return { ...result, chatId, done: enabled };
  }

  async setBox(chatId, enabled) {
    const card = await this.card(chatId);
    if (!own(card, 'parentCardId')) throw new FeishuError('STATE_UNAVAILABLE', 'The conversation box state was not returned.');
    const boxed = String(card.parentCardId) !== '0';
    if (boxed === enabled) return { status: 'already_set', chatId, boxed: enabled };
    const result = await this.verified(() => this.write(enabled ? 1006 : 1007, 'BoxCardsRequest', { feedCards: { [chatId]: 1 } }),
      async () => { const after = await this.card(chatId); return own(after, 'parentCardId') && (String(after.parentCardId) !== '0') === enabled; });
    return { ...result, chatId, boxed: enabled };
  }

  async state(chatId) {
    const [card, chat, muted, pinned, marked] = await Promise.all([this.card(chatId), this.chat(chatId), this.muted(chatId), this.pinned({ details: false }), this.marked({ details: false })]);
    const manualUnread = card.feedCardField ? (card.feedCardField.markAsUnread?.unread ?? false) : null;
    const unreadCount = own(chat, 'newMessageCount') ? chat.newMessageCount : null;
    const unread = unreadCount > 0 || manualUnread === true ? true : unreadCount === 0 && manualUnread === false ? false : null;
    return { chatId, pinned: pinned.items.some(x => x.id === chatId), marked: marked.items.some(x => x.id === chatId), muted,
      manualUnread, unread, unreadCount,
      readPosition: own(chat, 'readPosition') ? chat.readPosition : null,
      lastPosition: own(chat, 'lastMessagePosition') ? chat.lastMessagePosition : null,
      feedType: own(card, 'feedType') ? card.feedType : null,
      boxId: own(card, 'parentCardId') ? str(card.parentCardId) : null };
  }
}
