import { FeishuError } from './errors.js';

const valid = new Set(['messages', 'unread', 'muted', 'at_me', 'p2p', 'group', 'topic_group', 'docs', 'threads', 'done']);
const numeric = value => typeof value === 'string' && /^\d{1,19}$/.test(value);
const own = (o, k) => !!o && Object.hasOwn(o, k);

export class FeedGroups {
  constructor(gateway) { this.gateway = gateway; }
  async atMessages() {
    const p = await this.gateway.call(96, 'PullUnreadAtMessageIdsRequest', {}, { operation: 'group-query' });
    if (!own(p.packet, 'payload')) throw new FeishuError('INVALID_RESPONSE', 'Unread mention data was not returned.');
    const ids = this.gateway.decode('PullUnreadAtMessageIdsResponse', p.packet.payload).messageIds;
    const byChat = new Map(); let missing = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const r = await this.gateway.call(8, 'PullMessagesByIdsRequest', { messageIds: ids.slice(i, i + 100) }, { operation: 'group-query' });
      if (!own(r.packet, 'payload')) throw new FeishuError('INVALID_RESPONSE', 'Mention messages were not returned.');
      const messages = this.gateway.decode('PullMessagesByIdsResponse', r.packet.payload).messages;
      for (const id of ids.slice(i, i + 100)) {
        const m = messages[id]; if (!m?.chatId) { missing++; continue; }
        const list = byChat.get(m.chatId) || []; list.push(id); byChat.set(m.chatId, list);
      }
    }
    return { byChat, missing, total: ids.length };
  }
  async page({ group, cursor, parent, limit }) {
    const r = await this.gateway.call(1000, 'PullFeedCardsRequest', { type: group === 'done' ? 2 : 1,
      pullType: cursor ? 2 : 1, count: limit, ...(cursor ? { cursor } : {}), ...(parent ? { parentCardId: parent } : {}) },
    { operation: 'group-query', version: '5.7.0' });
    if (!own(r.packet, 'payload')) throw new FeishuError('INVALID_RESPONSE', 'Feed page was not returned.');
    return this.gateway.decode('PullFeedCardsResponse', r.packet.payload);
  }
  async query({ group, query, limit = 100, pages = 20, cursor, parent } = {}) {
    if (!valid.has(group) || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(pages) || pages < 1 || pages > 100 ||
      (query != null && typeof query !== 'string') || (cursor != null && !numeric(cursor)) || (parent != null && !numeric(parent))) {
      throw new FeishuError('INVALID_ARGUMENT', 'Invalid group query or pagination.');
    }
    const mention = group === 'at_me' ? await this.atMessages() : null;
    let next = cursor, items = [], boxes = [], scanned = 0, unknown = 0; const seen = new Set();
    for (let i = 0; i < pages; i++) {
      const page = await this.page({ group, cursor: next, parent, limit });
      const settings = {};
      if (group === 'muted') {
        const ids = page.cards.filter(c => c.type === 1).map(c => c.id);
        if (ids.length) {
          const r = await this.gateway.call(62, 'PullChatSettingsRequest', { chatIds: ids }, { operation: 'group-query' });
          if (!own(r.packet, 'payload')) throw new FeishuError('INVALID_RESPONSE', 'Notification settings were not returned.');
          Object.assign(settings, this.gateway.decode('PullChatSettingsResponse', r.packet.payload).chatSettings);
        }
      }
      for (const card of page.cards) {
        if (card.type === 5) { boxes.push({ id: String(card.id) }); continue; }
        const id = String(card.id), chat = page.chats[id], doc = page.docFeeds[id], thread = page.threads[id];
        let item;
        if (card.type === 1) {
          const count = own(chat, 'newMessageCount') ? chat.newMessageCount : null;
          const manual = card.feedCardField ? (card.feedCardField.markAsUnread?.unread ?? false) : null;
          const unread = count > 0 || manual === true ? true : count === 0 && manual === false ? false : null;
          item = { id, type: ({ 1: 'p2p', 2: 'group', 3: 'topic_group' })[chat?.type] || 'unknown', name: chat?.name || '', unread, unreadCount: count };
          if (group === 'muted') item.muted = own(settings[id], 'isRemind') ? !settings[id].isRemind : null;
          if (mention?.byChat.has(id)) item.atMessageIds = mention.byChat.get(id);
        } else if (card.type === 3) item = { id, type: 'docs', name: doc?.title || '', unreadCount: own(doc, 'newMessageCount') ? doc.newMessageCount : null, url: doc?.url || null };
        else if (card.type === 4) item = { id, type: 'threads', name: thread?.topic || '', chatId: thread?.channelId || null, unreadCount: own(thread, 'newMessageCount') ? thread.newMessageCount : null };
        else continue;
        scanned++;
        if (group === 'unread') {
          const state = item.type === 'docs' || item.type === 'threads' ? (item.unreadCount == null ? null : item.unreadCount > 0) : item.unread;
          if (state == null) { unknown++; continue; } if (!state) continue;
        } else if (group === 'muted') { if (item.muted == null) { unknown++; continue; } if (!item.muted) continue; }
        else if (group === 'at_me') { if (!mention.byChat.has(id)) continue; }
        else if (!['messages', 'done'].includes(group) && item.type !== group) continue;
        if (query && !item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
        items.push(item);
      }
      const cursorValue = own(page, 'nextCursor') && String(page.nextCursor) !== '0' ? String(page.nextCursor) : null;
      if (!cursorValue) { next = null; break; }
      if (seen.has(cursorValue) || cursorValue === next) throw new FeishuError('PAGINATION_INCOMPLETE', 'Feed pagination repeated its cursor.');
      seen.add(cursorValue); next = cursorValue;
    }
    return { group, items, boxes, scanned, unknownState: unknown, nextCursor: next ?? null, complete: next == null,
      ...(mention ? { mentionMessages: mention.total, unmappedMentionMessages: mention.missing } : {}) };
  }
}
