import { uploadFile } from './upload.js';
import { FeishuError, requireNumericId, requireInt64Id, requireText } from './errors.js';
import { shortId } from './gateway.js';
import { downloadFile } from './download.js';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';

function ids(values, label) {
  if (!Array.isArray(values)) throw new FeishuError('INVALID_ARGUMENT', `${label} must be a list.`);
  return [...new Set(values.map(value => requireNumericId(value, label)))];
}

function decodedPayload(gateway, response, type, operation) {
  if (!response.packet.payload?.length) {
    throw new FeishuError('EFFECT_UNKNOWN', 'No confirmation was returned; inspect the chat before retrying.',
      { operation, requestId: response.requestId });
  }
  try { return gateway.decode(type, response.packet.payload); }
  catch {
    throw new FeishuError('EFFECT_UNKNOWN', 'The confirmation was unreadable; inspect the chat before retrying.',
      { operation, requestId: response.requestId });
  }
}

export class LarkMateClient {
  constructor(gateway) { this.gateway = gateway; }

  async contactAlias({ userId }) {
    requireInt64Id(userId, 'user ID');
    const r = await this.gateway.call(5031, 'PullContactProfileV2Request', { scene: 1, userId, useNewLayout: true }, { operation: 'contact-alias' });
    const p = this.gateway.decode('PullContactProfileV2Response', r.packet.payload);
    if (!p.profile || !Array.isArray(p.profile.fields)) throw new FeishuError('STATE_UNAVAILABLE', 'Contact profile was not returned.');
    const field = p.profile.fields.find(x => x.fieldValueType === 50 && x.key === 'B-ALIAS');
    if (!field) return { userId, alias: '' };
    try { const alias = JSON.parse(field.strFieldVal).text.default_val; if (typeof alias !== 'string') throw new Error(); return { userId, alias }; }
    catch { throw new FeishuError('INVALID_RESPONSE', 'Contact alias was unreadable.'); }
  }

  async contactNote({ userId }) {
    requireInt64Id(userId, 'user ID');
    const r = await this.gateway.call(5031, 'PullContactProfileV2Request', { scene: 1, userId, useNewLayout: true }, { operation: 'contact-note' });
    const p = this.gateway.decode('PullContactProfileV2Response', r.packet.payload);
    if (!p.profile || !Array.isArray(p.profile.fields)) throw new FeishuError('STATE_UNAVAILABLE', 'Contact profile was not returned.');
    const field = p.profile.fields.find(x => x.fieldValueType === 105 && x.key === 'B-MEMO-DESCRIPTION');
    if (!field) return { userId, description: '', hasImages: false, hasRichText: false };
    try {
      const note = JSON.parse(field.strFieldVal);
      const elements = Object.values(note.memo_text_v2?.elements?.dictionary || {});
      return { userId, description: note.memo_text ?? note.memo_text_v2?.inner_text ?? '',
        hasImages: !!note.memo_picture || !!note.memo_picture_v2?.length,
        hasRichText: elements.some(x => x.tag !== 1) };
    } catch { throw new FeishuError('INVALID_RESPONSE', 'Contact note was unreadable.'); }
  }

  async setContactNote({ userId, description }) {
    requireInt64Id(userId, 'user ID');
    if (typeof description !== 'string' || Buffer.byteLength(description) > 65536) throw new FeishuError('INVALID_ARGUMENT', 'Description must be a string up to 64 KiB.');
    const before = await this.contactNote({ userId });
    if (before.hasImages || before.hasRichText) throw new FeishuError('UNSUPPORTED_NOTE_CONTENT', 'The note contains images or rich text; use Feishu to preserve them.');
    if (before.description === description) return { status: 'already_set', userId, description };
    const r = await this.gateway.call(5036, 'PatchUserMemoRequest', { targetUserId: userId, memoText: description }, { mutating: true, operation: 'contact-note-set' });
    try { const after = await this.contactNote({ userId }); return { status: after.description === description ? 'verified' : 'submitted_unconfirmed', userId, requestId: r.requestId }; }
    catch { return { status: 'submitted_unconfirmed', userId, requestId: r.requestId }; }
  }

  async setContactAlias({ userId, alias }) {
    requireInt64Id(userId, 'user ID');
    if (typeof alias !== 'string' || Buffer.byteLength(alias) > 1024) throw new FeishuError('INVALID_ARGUMENT', 'Alias must be a string up to 1024 bytes.');
    const before = await this.contactAlias({ userId });
    if (before.alias === alias) return { status: 'already_set', userId, alias };
    const r = await this.gateway.call(5400, 'PutUserAliasRequest', { targetId: userId, name: alias }, { mutating: true, operation: 'contact-alias-set' });
    try { const after = await this.contactAlias({ userId }); return { status: after.alias === alias ? 'verified' : 'submitted_unconfirmed', userId, requestId: r.requestId }; }
    catch { return { status: 'submitted_unconfirmed', userId, requestId: r.requestId }; }
  }

  async setGroupNickname({ chatId, nickname }) {
    requireInt64Id(chatId, 'chat ID');
    if (typeof nickname !== 'string' || Buffer.byteLength(nickname) > 1024) throw new FeishuError('INVALID_ARGUMENT', 'Nickname must be a string up to 1024 bytes.');
    const r = await this.gateway.call(5401, 'PutGroupNicknameRequest', { chatId, nickname }, { mutating: true, operation: 'group-nickname-set' });
    try {
      const me = await this.gateway.authenticate();
      const p = await this.gateway.call(5031, 'PullContactProfileV2Request', { scene: 1, userId: me.id, chatId, useNewLayout: true }, { operation: 'group-nickname-read' });
      const meta = this.gateway.decode('PullContactProfileV2Response', p.packet.payload).chatChatter;
      return { status: String(meta?.chatId) === chatId && meta.groupNickname === nickname ? 'verified' : 'submitted_unconfirmed', chatId, requestId: r.requestId };
    } catch { return { status: 'submitted_unconfirmed', chatId, requestId: r.requestId }; }
  }

  async clearChatHistory({ chatId }) {
    requireInt64Id(chatId, 'chat ID');
    const info = await this.chatInfo(chatId);
    if (!Number.isInteger(info.lastMessagePosition) || info.lastMessagePosition < 0) throw new FeishuError('POSITION_UNAVAILABLE', 'The last message position is unavailable.');
    if (!info.lastMessagePosition) return { status: 'already_empty', chatId };
    const r = await this.gateway.call(900011, 'CleanUserChatMessageRequest', { chatId, position: info.lastMessagePosition }, { mutating: true, operation: 'chat-clear-history' });
    return { status: 'submitted_unconfirmed', chatId, throughPosition: info.lastMessagePosition, requestId: r.requestId };
  }

  async setGroupAvatar({ chatId, path }) {
    requireInt64Id(chatId, 'chat ID');
    let file, dispatched = false;
    try {
      file = await open(path, 'r'); const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 10 * 1024 * 1024) throw new FeishuError('FILE_INVALID', 'Use an image up to 10 MiB.');
      const b = await file.readFile();
      let mime;
      if (b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) mime = 'image/png';
      else if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) mime = 'image/jpeg';
      else if (b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WEBP') mime = 'image/webp';
      else throw new FeishuError('FILE_INVALID', 'Use a PNG, JPEG or WebP image.');
      const getAvatar = async () => { const x = await this.gateway.call(64, 'PullChatsByIdsRequest', { chatIds: [chatId] }, { operation: 'group-avatar-read' }); const chat = this.gateway.decode('PullChatsByIdsResponse', x.packet.payload).chats?.[chatId]; if (!chat || ![2, 3].includes(chat.type)) throw new FeishuError('NOT_FOUND', 'Group was not found.'); return chat.avatar?.key || null; };
      const before = await getAvatar();
      dispatched = true;
      const r = await this.gateway.call(72, 'PatchGroupChatRequest', { chatId, iconData: `data:${mime};base64,${b.toString('base64')}`, updateFields: [2] }, { mutating: true, operation: 'group-avatar-set' });
      const result = decodedPayload(this.gateway, r, 'PatchGroupChatResponse', 'group-avatar-set');
      if (!result.chat?.id || String(result.chat.id) !== chatId) throw new FeishuError('EFFECT_UNKNOWN', 'Group avatar update was not confirmed.', { requestId: r.requestId });
      try { const after = await getAvatar(); return { status: after && after !== before ? 'verified' : 'submitted_unconfirmed', chatId, requestId: r.requestId }; }
      catch { return { status: 'submitted_unconfirmed', chatId, requestId: r.requestId }; }
    } catch (e) { if (e instanceof FeishuError) throw e; throw new FeishuError(dispatched ? 'EFFECT_UNKNOWN' : 'FILE_UNAVAILABLE', dispatched ? 'The avatar update could not be confirmed; inspect before retrying.' : 'Cannot read the image or group.'); }
    finally { await file?.close(); }
  }

  async status() {
    return { status: 'ready', identity: 'user', user: await this.gateway.authenticate() };
  }

  async search(query) {
    requireText(query, 'query');
    const response = await this.gateway.call(11021, 'UniversalSearchRequest', {
      header: {
        searchSession: shortId(), sessionSeqId: 1, query, locale: 'zh_CN',
        searchContext: {
          tagName: 'SMART_SEARCH',
          entityItems: [{ type: 1 }, { type: 2 }, { type: 3, filter: { groupChatFilter: {} } }],
          commonFilter: { includeOuterTenant: true }, sourceKey: 'messenger',
        },
      },
    }, { operation: 'search' });
    if (!response.packet.payload?.length) return { items: [] };
    let data;
    try { data = this.gateway.decode('UniversalSearchResponse', response.packet.payload); }
    catch { throw new FeishuError('INVALID_RESPONSE', 'The search response was unreadable.'); }
    const names = { 1: 'user', 2: 'bot', 3: 'group' };
    return { items: (data.results || []).map(item => ({
      id: String(item.id || ''), type: names[item.type] || 'unknown',
      name: (item.titleHighlighted || '').replace(/<[^>]+>/g, ''),
    })) };
  }

  async searchMessages({ query, limit = 20, cursor } = {}) {
    requireText(query, 'query');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FeishuError('INVALID_ARGUMENT', 'limit must be between 1 and 100.');
    let state = { session: shortId(), seq: 1, token: '' };
    if (cursor != null) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 65536 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        state = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (state.query !== query || typeof state.session !== 'string' || !/^[a-zA-Z0-9]{1,64}$/.test(state.session) || !Number.isSafeInteger(state.seq) || state.seq < 2 || typeof state.token !== 'string' || !state.token) throw new Error();
      } catch { throw new FeishuError('INVALID_ARGUMENT', 'Invalid cursor or cursor does not match the query.'); }
    }
    const response = await this.gateway.call(11021, 'UniversalSearchRequest', { header: {
      searchSession: state.session, sessionSeqId: state.seq, query, locale: 'zh_CN', pageSize: limit,
      ...(state.token ? { paginationToken: state.token } : {}),
      searchContext: { tagName: 'SEARCH_MESSAGES', entityItems: [{ type: 5 }], commonFilter: { includeOuterTenant: true }, sourceKey: 'messenger' },
    } }, { operation: 'search-messages' });
    let data;
    try { data = this.gateway.decode('UniversalSearchResponse', response.packet.payload); }
    catch { throw new FeishuError('INVALID_RESPONSE', 'The message search response was unreadable.'); }
    if (data.header?.errorCode) throw new FeishuError('SEARCH_REJECTED', 'Feishu rejected the message search.', { status: data.header.errorCode });
    if (!data.header || (data.header.hasMore && !data.header.paginationToken)) throw new FeishuError('INVALID_RESPONSE', 'The message search response did not include a usable cursor.');
    const items = (data.results || []).filter(item => item.type === 5).map(item => {
      const m = item.meta?.message;
      return { id: String(item.id || ''), chatId: m?.chatId || null, senderId: m?.senderId || null,
        position: m && Object.hasOwn(m, 'position') ? m.position : null,
        createTime: m && Object.hasOwn(m, 'createTime') ? String(m.createTime) : null,
        title: (item.titleHighlighted || '').replace(/<[^>]+>/g, ''),
        snippet: (item.summaryHighlighted || '').replace(/<[^>]+>/g, '') };
    });
    const nextCursor = data.header.hasMore ? Buffer.from(JSON.stringify({ query, session: state.session, seq: state.seq + 1, token: data.header.paginationToken })).toString('base64url') : null;
    return { items, total: Object.hasOwn(data.header, 'total') ? data.header.total : null, hasMore: !!data.header.hasMore, nextCursor,
      secondaryStageSearchable: data.header.secondaryStageSearchable ?? null };
  }

  async chats({ limit = 50, cursor, parent, scope = 'inbox' } = {}) {
    if (!['inbox', 'done'].includes(scope)) throw new FeishuError('INVALID_ARGUMENT', 'scope must be inbox or done.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FeishuError('INVALID_ARGUMENT', 'limit must be between 1 and 100.');
    for (const [value, label] of [[cursor, 'cursor'], [parent, 'parent']]) {
      if (value != null && !/^[0-9]{1,19}$/.test(String(value))) throw new FeishuError('INVALID_ARGUMENT', label + ' must be a numeric identifier.');
    }
    const response = await this.gateway.call(1000, 'PullFeedCardsRequest', {
      type: scope === 'done' ? 2 : 1, pullType: cursor ? 2 : 1, count: limit,
      ...(cursor ? { cursor: String(cursor) } : {}), ...(parent ? { parentCardId: String(parent) } : {}),
    }, { operation: 'list-chats', version: '5.7.0' });
    if (!response.packet.payload?.length) throw new FeishuError('INVALID_RESPONSE', 'No inbox page was returned.');
    let page;
    try { page = this.gateway.decode('PullFeedCardsResponse', response.packet.payload); }
    catch { throw new FeishuError('INVALID_RESPONSE', 'The inbox page was unreadable.'); }
    const types = { 1: 'p2p', 2: 'group', 3: 'topic_group' };
    const items = [], boxes = [];
    for (const card of page.cards || []) {
      if (card.type === 5) { boxes.push({ id: String(card.id) }); continue; }
      if (card.type !== 1) continue;
      const chat = page.chats?.[card.id];
      const unreadCount = chat && Object.hasOwn(chat, 'newMessageCount') ? chat.newMessageCount : null;
      const manualUnread = card.feedCardField ? (card.feedCardField.markAsUnread?.unread ?? false) : null;
      const unread = unreadCount > 0 || manualUnread === true ? true : unreadCount === 0 && manualUnread === false ? false : null;
      items.push({ id: String(card.id), name: chat?.name || '', type: types[chat?.type] || 'unknown',
        updatedAt: Object.hasOwn(card, 'updateTime') ? String(card.updateTime) : null, unreadCount, manualUnread, unread });
    }
    const nextCursor = Object.hasOwn(page, 'nextCursor') && String(page.nextCursor) !== '0' ? String(page.nextCursor) : null;
    return { items, boxes, nextCursor, scope };
  }

  async openChat(userId) {
    requireNumericId(userId, 'user ID');
    const response = await this.gateway.call(13, 'PutChatRequest', { type: 1, chatterIds: [userId] },
      { mutating: true, operation: 'open-chat' });
    const result = decodedPayload(this.gateway, response, 'PutChatResponse', 'open-chat');
    if (!result.chat?.id) throw new FeishuError('EFFECT_UNKNOWN', 'No chat ID was returned; inspect before retrying.');
    return { chatId: result.chat.id, status: 'opened' };
  }

  async chatInfo(chatId) {
    requireNumericId(chatId, 'chat ID');
    const response = await this.gateway.call(64, 'PullChatsByIdsRequest', { chatIds: [chatId] }, { operation: 'chat-info' });
    if (!response.packet.payload?.length) throw new FeishuError('NOT_FOUND', 'The chat was not found.');
    let result;
    try { result = this.gateway.decode('PullChatsByIdsResponse', response.packet.payload); }
    catch { throw new FeishuError('INVALID_RESPONSE', 'The chat response was unreadable.'); }
    const chat = result.chats?.[chatId];
    if (!chat?.id || String(chat.id) !== chatId) throw new FeishuError('NOT_FOUND', 'The requested chat was not found.');
    const types = { 1: 'p2p', 2: 'group', 3: 'topic_group' };
    const memberCount = Object.hasOwn(chat, 'memberCount') ? chat.memberCount
      : Object.hasOwn(chat, 'userCount') ? chat.userCount : null;
    return { id: String(chat.id), name: chat.name || '', type: types[chat.type] || 'unknown',
      description: Object.hasOwn(chat, 'description') ? chat.description : null,
      isDissolved: Object.hasOwn(chat, 'isDissolved') ? chat.isDissolved : null,
      memberCount,
      lastMessagePosition: Object.hasOwn(chat, 'lastMessagePosition') ? chat.lastMessagePosition : null };
  }

  async updateGroup({ chatId, name, description }) {
    requireNumericId(chatId, 'chat ID');
    if (name == null && description == null) {
      throw new FeishuError('INVALID_ARGUMENT', 'Specify a group name or description.');
    }
    if (name != null) requireText(name, 'group name');
    if (description != null && typeof description !== 'string') {
      throw new FeishuError('INVALID_ARGUMENT', 'description must be a string.');
    }
    const updateFields = [];
    if (name != null) updateFields.push(1);
    if (description != null) updateFields.push(3);
    const response = await this.gateway.call(72, 'PatchGroupChatRequest', {
      chatId, ...(name != null ? { name } : {}), ...(description != null ? { description } : {}), updateFields,
    }, { mutating: true, operation: 'update-group' });
    const result = decodedPayload(this.gateway, response, 'PatchGroupChatResponse', 'update-group');
    if (!result.chat?.id || String(result.chat.id) !== chatId) {
      throw new FeishuError('EFFECT_UNKNOWN', 'The requested group was not confirmed; inspect before retrying.',
        { requestId: response.requestId });
    }
    const confirmed = (name == null || (Object.hasOwn(result.chat, 'name') && result.chat.name === name))
      && (description == null || (Object.hasOwn(result.chat, 'description') && result.chat.description === description));
    return { status: confirmed ? 'updated' : 'submitted_unconfirmed', chatId, requestId: response.requestId };
  }

  async dissolveGroup(chatId) {
    requireNumericId(chatId, 'chat ID');
    const response = await this.gateway.call(72, 'PatchGroupChatRequest', {
      chatId, isDissolved: true, updateFields: [16],
    }, { mutating: true, operation: 'dissolve-group' });
    const result = decodedPayload(this.gateway, response, 'PatchGroupChatResponse', 'dissolve-group');
    if (!result.chat?.id || String(result.chat.id) !== chatId) {
      throw new FeishuError('EFFECT_UNKNOWN', 'The requested group was not confirmed; inspect before retrying.',
        { requestId: response.requestId });
    }
    return { status: result.chat.isDissolved === true ? 'dissolved' : 'submitted_unconfirmed',
      chatId, requestId: response.requestId };
  }

  async history({ chatId, limit = 20, start }) {
    requireNumericId(chatId, 'chat ID');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new FeishuError('INVALID_ARGUMENT', 'limit must be an integer between 1 and 100.');
    }
    if (start != null && (!Number.isInteger(start) || start < 1 || start + limit - 1 > 2147483647)) {
      throw new FeishuError('INVALID_ARGUMENT', 'start and the requested page must fit the positive 32-bit position range.');
    }
    const info = start == null ? await this.chatInfo(chatId) : null;
    if (info && info.lastMessagePosition == null) {
      throw new FeishuError('POSITION_UNAVAILABLE', 'The latest message position was not returned; provide --start.');
    }
    if (info && info.lastMessagePosition === 0) return { items: [] };
    const first = start ?? Math.max(1, info.lastMessagePosition - limit + 1);
    const end = start == null ? info.lastMessagePosition : first + limit - 1;
    const positions = Array.from({ length: end - first + 1 }, (_, index) => first + index);
    const response = await this.gateway.call(43, 'PullMessagesByPositionsRequest', { chatId, positions },
      { operation: 'history' });
    if (!response.packet.payload?.length) throw new FeishuError('INVALID_RESPONSE', 'No history page was returned.');
    let data;
    try { data = this.gateway.decode('PullMessagesByPositionsResponse', response.packet.payload); }
    catch { throw new FeishuError('INVALID_RESPONSE', 'The history page was unreadable.'); }
    const requested = new Set(positions);
    const items = Object.entries(data.messages || {}).filter(([position]) => requested.has(Number(position))).map(([position, message]) => {
      let text = null;
      if (message.content?.length && (message.type === 4 || message.type === 2)) {
        try {
          const content = this.gateway.decode(message.type === 4 ? 'TextContent' : 'PostContent', message.content);
          text = content.richText?.innerText || content.text || null;
        } catch { /* Keep unsupported or undecodable content explicitly unknown. */ }
      }
      let resource = null;
      if (message.content?.length && (message.type === 3 || message.type === 5)) {
        try {
          const content = this.gateway.decode(message.type === 3 ? 'FileContent' : 'ImageContent', message.content);
          resource = message.type === 3
            ? { key: content.key || null, name: content.name || null, size: Object.hasOwn(content, 'size') ? String(content.size) : null, mime: content.mime || null }
            : { key: content.imageV2?.imageKey || content.image?.imageKey || content.image?.key || null };
        } catch { /* Leave unknown resources unparsed. */ }
      }
      return { id: String(message.id || ''), position: Number(position), rootId: message.rootId || null, parentId: message.parentId || null,
        senderId: message.fromId || '', type: message.type, text,
        createTime: Object.hasOwn(message, 'createTime') ? String(message.createTime) : null, resource };
    }).sort((a, b) => a.position - b.position);
    return { items, requestedPositions: positions.length,
      omittedPositions: positions.length - items.length, nextStart: first > 1 ? Math.max(1, first - limit) : null,
      nextLimit: first > 1 ? Math.min(limit, first - 1) : null,
      hasMore: Object.hasOwn(data, 'hasMore') ? data.hasMore : null };
  }

  async historyPages({ chatId, limit = 20, start, pages = 1, query, sender, after, before }) {
    if (!Number.isInteger(pages) || pages < 1 || pages > 100) throw new FeishuError('INVALID_ARGUMENT', 'pages must be between 1 and 100.');
    if (sender) requireNumericId(sender, 'sender ID');
    for (const [value, label] of [[after, 'after'], [before, 'before']]) {
      if (value != null && (!Number.isSafeInteger(value) || value < 0)) throw new FeishuError('INVALID_ARGUMENT', label + ' must be a Unix timestamp in seconds.');
    }
    if (after != null && before != null && after > before) throw new FeishuError('INVALID_ARGUMENT', 'after must not be later than before.');
    let next = start, pageLimit = limit, nextLimit = null, scanned = 0, omittedPositions = 0, missingTimestamps = 0, items = [];
    for (let i = 0; i < pages; i++) {
      const page = await this.history({ chatId, limit: pageLimit, start: next });
      scanned += page.requestedPositions || 0;
      omittedPositions += page.omittedPositions || 0;
      items.push(...page.items.filter(item => {
        if (sender && item.senderId !== sender) return false;
        if (query && !(item.text || '').includes(query)) return false;
        if (after != null || before != null) {
          if (item.createTime == null) { missingTimestamps++; return false; }
          const time = Number(item.createTime);
          if (!Number.isSafeInteger(time)) { missingTimestamps++; return false; }
          if ((after != null && time < after) || (before != null && time > before)) return false;
        }
        return true;
      }));
      next = page.nextStart;
      nextLimit = page.nextLimit;
      pageLimit = nextLimit;
      if (next == null) break;
    }
    items.sort((a, b) => a.position - b.position);
    return { items, scannedPositions: scanned, omittedPositions, missingTimestamps, nextStart: next ?? null, nextLimit, filterScope: 'scanned_positions_only' };
  }

  async sendFile({ chatId, path }) {
    requireNumericId(chatId, 'chat ID');
    requireText(path, 'file path');
    const file = await uploadFile(this.gateway, path);
    const cid = shortId();
    const response = await this.gateway.call(5, 'PutMessageRequest', {
      type: 3, chatId, cid, isNotified: true, version: 1,
      content: { fileKey: file.key, fileName: file.name, fileSize: file.size },
    }, { version: '5.7.0', mutating: true, operation: 'send-file' });
    let id = null;
    try {
      if (response.packet.payload?.length) {
        const message = this.gateway.decode('PutMessageResponse', response.packet.payload).message;
        if (message?.id && !String(message.id).startsWith('-') && (!message.chatId || message.chatId === chatId)) id = String(message.id);
      }
    } catch { /* Submission remains unconfirmed. */ }
    return { status: id ? 'accepted' : 'submitted_unconfirmed', chatId, messageId: id, cid, requestId: response.requestId, fileName: file.name };
  }

  async reaction({ messageId, emoji = 'DarkThumbsup', remove = false }) {
    requireInt64Id(messageId, 'message ID');
    if (typeof emoji !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(emoji)) {
      throw new FeishuError('INVALID_ARGUMENT', 'emoji must be a Feishu reaction name.');
    }
    if (typeof remove !== 'boolean') throw new FeishuError('INVALID_ARGUMENT', 'remove must be a boolean.');
    const result = await this.gateway.call(remove ? 26 : 25, 'MessageReactionRequest', {
      messageId, reactionType: emoji, reactionStrategyVersion: 1,
    }, { version: '5.7.0', mutating: true, operation: remove ? 'remove-reaction' : 'add-reaction' });
    return { status: 'submitted_unconfirmed', messageId, emoji, action: remove ? 'remove' : 'add', requestId: result.requestId };
  }

  async sendImage({ chatId, path }) {
    requireInt64Id(chatId, 'chat ID');
    requireText(path, 'image path');
    const image = await uploadFile(this.gateway, path, { image: true });
    const cid = shortId();
    const response = await this.gateway.call(5, 'PutMessageRequest', {
      type: 5, chatId, cid, isNotified: true, version: 1,
      rootId: '', parentId: '', isReplyInThread: false, isShare: false, aiInfoContext: new Uint8Array(), syncToChat: false, observedField20: 0,
      content: { thumbnailKey: image.key },
    }, { version: '8.5.0', mutating: true, operation: 'send-image' });
    let id = null;
    try {
      if (response.packet.payload?.length) {
        const m = this.gateway.decode('PutMessageResponse', response.packet.payload).message;
        if (m?.id && !String(m.id).startsWith('-') && (!m.chatId || m.chatId === chatId)) id = String(m.id);
      }
    } catch { /* Submission remains unconfirmed. */ }
    return { status: id ? 'accepted' : 'submitted_unconfirmed', chatId, messageId: id, cid, requestId: response.requestId };
  }

  async downloadFile(options) { return downloadFile(this.gateway, options); }

  async messageLink({ chatId, messageId }) {
    requireInt64Id(chatId, 'chat ID');
    requireInt64Id(messageId, 'message ID');
    const response = await this.gateway.call(1150, 'MessageLinkRequest', { chatId, type: 1, messageId }, { operation: 'message-link' });
    let result, url;
    try {
      result = this.gateway.decode('MessageLinkResponse', response.packet.payload);
      url = new URL(result.url);
    } catch { throw new FeishuError('INVALID_RESPONSE', 'No valid message link was returned.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'applink.feishu.cn' || url.pathname !== '/client/message/link/open' || !result.token || url.searchParams.get('token') !== result.token) {
      throw new FeishuError('INVALID_RESPONSE', 'No valid message link was returned.');
    }
    return { chatId, messageId, url: url.href };
  }

  async editMessage({ messageId, text }) {
    requireInt64Id(messageId, 'message ID');
    requireText(text, 'text');
    await this.gateway.authenticate();
    const paragraph = '2', element = '3', cid = shortId();
    const response = await this.gateway.call(900010, 'EditMessageRequest', {
      messageId, cid, type: 4, content: { extra: new Uint8Array(), richText: {
        elementIds: [paragraph], innerText: text, elements: { dictionary: {
          [paragraph]: { tag: 3, property: new Uint8Array(), childIds: [element] },
          [element]: { tag: 1, property: this.gateway.encode('TextProperty', { content: text }) },
        } },
      } },
    }, { version: '8.5.0', mutating: true, operation: 'edit-message' });
    return { status: 'submitted_unconfirmed', messageId, requestId: response.requestId };
  }

  async forwardMessage({ chatId, messageId, targetChatId }) {
    requireInt64Id(chatId, 'source chat ID');
    requireInt64Id(messageId, 'message ID');
    requireInt64Id(targetChatId, 'target chat ID');
    const cid = randomUUID();
    const response = await this.gateway.call(51, 'ForwardMessageRequest', {
      sourceChatId: chatId, messageId, targetCids: { [targetChatId]: cid }, type: 1,
      targets: { [targetChatId]: { type: 1 } }, extra: new Uint8Array(),
    }, { version: '8.5.0', mutating: true, operation: 'forward-message' });
    return { status: 'submitted_unconfirmed', chatId, messageId, targetChatId, cid, requestId: response.requestId };
  }

  async recallMessage(messageId) {
    requireInt64Id(messageId, 'message ID');
    const response = await this.gateway.call(9, 'RecallMessageRequest', { messageId },
      { version: '8.5.0', mutating: true, operation: 'recall-message' });
    return { status: 'submitted_unconfirmed', messageId, requestId: response.requestId };
  }

  async favoriteMessage({ chatId, messageId }) {
    requireInt64Id(chatId, 'chat ID');
    requireInt64Id(messageId, 'message ID');
    const response = await this.gateway.call(500, 'PutFavoriteRequest', { favs: [{ id: messageId, type: 1, chatId }] },
      { version: '8.5.0', mutating: true, operation: 'favorite-message' });
    let favoriteId = null;
    try {
      const ids = this.gateway.decode('PutFavoriteResponse', response.packet.payload).ids;
      if (ids.length === 1 && /^\d+$/.test(String(ids[0])) && String(ids[0]) !== '0') favoriteId = String(ids[0]);
    } catch { /* Submission remains unconfirmed. */ }
    return { status: favoriteId ? 'accepted' : 'submitted_unconfirmed', chatId, messageId, favoriteId, requestId: response.requestId };
  }

  async removeFavorite(favoriteId) {
    requireInt64Id(favoriteId, 'favorite ID');
    const response = await this.gateway.call(502, 'DeleteFavoriteRequest', { ids: [favoriteId] },
      { version: '8.5.0', mutating: true, operation: 'remove-favorite' });
    return { status: 'submitted_unconfirmed', favoriteId, requestId: response.requestId };
  }

  async favorites({ limit = 50 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FeishuError('INVALID_ARGUMENT', 'limit must be between 1 and 100.');
    const response = await this.gateway.call(503, 'PullAllFavoritesRequest', { lastId: '0', count: limit }, { operation: 'favorites' });
    let result;
    try { result = this.gateway.decode('PullAllFavoritesResponse', response.packet.payload); }
    catch { throw new FeishuError('INVALID_RESPONSE', 'The favorites response was unreadable.'); }
    const items = result.favs.map(fav => {
      let message = null;
      if (fav.type === 1 && fav.content?.length) {
        try {
          const m = this.gateway.decode('MessageEntity', fav.content);
          let text = null;
          if (m.content?.length && (m.type === 4 || m.type === 2)) {
            const body = this.gateway.decode(m.type === 4 ? 'TextContent' : 'PostContent', m.content);
            text = body.richText?.innerText || body.text || null;
          }
          message = { id: m.id || null, chatId: m.chatId || null, senderId: m.fromId || null, type: m.type, text };
        } catch { /* Keep the favorite ID if its content type is not understood. */ }
      }
      return { id: String(fav.id), createTime: Object.hasOwn(fav, 'createTime') ? String(fav.createTime) : null, type: fav.type, message };
    });
    return { items, hasMore: !!result.hasMore };
  }

  async send({ chatId, text, mentions = [], replyTo, replyRoot }) {
    requireNumericId(chatId, 'chat ID');
    requireText(text, 'text');
    if (replyTo) requireNumericId(replyTo, 'reply message ID');
    if (replyRoot) requireNumericId(replyRoot, 'reply root ID');
    if (replyRoot && !replyTo) throw new FeishuError('INVALID_ARGUMENT', 'reply-root requires reply-to.');
    if (!Array.isArray(mentions)) throw new FeishuError('INVALID_ARGUMENT', 'mentions must be a list.');
    await this.gateway.authenticate();
    const elementIds = [];
    const atIds = [];
    const dictionary = {};
    let remaining = text;
    const addText = part => {
      if (!part) return;
      const id = shortId();
      elementIds.push(id);
      dictionary[id] = { tag: 1, property: this.gateway.encode('TextProperty', { content: part }) };
    };
    for (const mention of mentions) {
      requireNumericId(mention.id, 'mention ID');
      const marker = `@${requireText(mention.name, 'mention name')}`;
      const index = remaining.indexOf(marker);
      if (index < 0) throw new FeishuError('INVALID_ARGUMENT', 'The mention marker is absent from the text.');
      addText(remaining.slice(0, index));
      const id = shortId();
      elementIds.push(id);
      atIds.push(id);
      dictionary[id] = { tag: 5, property: this.gateway.encode('AtProperty', { userId: mention.id, content: marker }) };
      remaining = remaining.slice(index + marker.length);
    }
    addText(remaining);
    const cid = shortId();
    const response = await this.gateway.call(5, 'PutMessageRequest', {
      type: 4, chatId, cid, isNotified: true, version: 1,
      ...(replyTo ? { parentId: replyTo, rootId: replyRoot || replyTo } : {}),
      content: { richText: { elementIds, innerText: text, elements: { dictionary }, atIds } },
    }, { version: '5.7.0', mutating: true, operation: 'send' });
    return { status: 'submitted_unconfirmed', chatId, cid, requestId: response.requestId };
  }

  async resolveMembers(memberIds) {
    if (!memberIds.length) return [];
    const response = await this.gateway.call(46, 'PullChattersByIdsRequest', {
      chatterIds: memberIds, needBotInfo: true, notSubscribeChatters: true,
    }, { operation: 'resolve-members' });
    if (!response.packet.payload?.length) throw new FeishuError('INVALID_RESPONSE', 'No member information was returned.');
    let data;
    try { data = this.gateway.decode('PullChattersByIdsResponse', response.packet.payload); }
    catch { throw new FeishuError('INVALID_RESPONSE', 'The member information was unreadable.'); }
    return memberIds.map(id => {
      const chatter = data.chatters?.[id];
      if (!chatter || String(chatter.id || '') !== id || !Object.hasOwn(chatter, 'type')
          || (chatter.type !== 1 && chatter.type !== 2)) {
        throw new FeishuError('MEMBER_TYPE_UNKNOWN', 'Cannot establish whether a member is a user or a bot.', { memberId: id });
      }
      return { id, type: chatter.type === 1 ? 'user' : 'bot' };
    });
  }

  async botProtection({ chatId, botId }) {
    requireNumericId(chatId, 'chat ID');
    requireNumericId(botId, 'bot ID');
    const { data } = await this.gateway.botApi('fetch_bot_conf_resource', {
      chat_id: chatId, bot_id: botId,
    }, { operation: 'read-bot-protection' });
    if (data.ok !== true || !Array.isArray(data.fields)) {
      throw new FeishuError('PROTECTION_UNAVAILABLE', 'Feishu did not return the bot protection setting.');
    }
    const field = data.fields.find(item => item.field_key === 'check_mender');
    const value = field?.field_value || field?.default_value;
    if (value !== 'true' && value !== 'false') {
      throw new FeishuError('PROTECTION_UNAVAILABLE', 'Feishu did not return the bot protection setting.');
    }
    return { chatId, botId, enabled: value === 'true' };
  }

  async setBotProtection({ chatId, botId, enabled = true }) {
    requireNumericId(chatId, 'chat ID');
    requireNumericId(botId, 'bot ID');
    if (typeof enabled !== 'boolean') throw new FeishuError('INVALID_ARGUMENT', 'enabled must be a boolean.');
    const result = await this.gateway.botApi('UpdateAppBotInfo', {
      chat_id: chatId, bot_id: botId, check_mender: enabled,
    }, { mutating: true, operation: 'set-bot-protection' });
    return this.verifyBotProtection({ chatId, botId, enabled, requestId: result.requestId });
  }

  async verifyBotProtection({ chatId, botId, enabled, requestId }) {
    try {
      const current = await this.botProtection({ chatId, botId });
      return { chatId, botId, requestId, enabled: current.enabled,
        status: current.enabled === enabled ? 'verified' : 'protection_mismatch' };
    } catch (error) {
      return { chatId, botId, requestId, enabled: null, status: 'submitted_unconfirmed',
        verificationError: error instanceof FeishuError ? error.code : 'INVALID_RESPONSE' };
    }
  }

  async inviteBot({ chatId, botId, protect = true }) {
    requireNumericId(chatId, 'chat ID');
    requireNumericId(botId, 'bot ID');
    if (typeof protect !== 'boolean') throw new FeishuError('INVALID_ARGUMENT', 'protect must be a boolean.');
    const result = await this.gateway.botApi('SetBotAddConf', {
      chat_id: chatId, bot_id: botId, check_mender: protect,
    }, { mutating: true, operation: 'invite-bot' });
    return this.verifyBotProtection({ chatId, botId, enabled: protect, requestId: result.requestId });
  }

  async createGroup({ name, description, memberIds = [], protectBots = true }) {
    requireText(name, 'group name');
    if (description != null && typeof description !== 'string') {
      throw new FeishuError('INVALID_ARGUMENT', 'description must be a string.');
    }
    if (typeof protectBots !== 'boolean') throw new FeishuError('INVALID_ARGUMENT', 'protectBots must be a boolean.');
    const members = await this.resolveMembers(ids(memberIds, 'member ID'));
    const users = members.filter(item => item.type === 'user').map(item => item.id);
    const bots = members.filter(item => item.type === 'bot');
    const response = await this.gateway.call(13, 'PutChatRequest', {
      type: 2, groupName: name, ...(description ? { groupDesc: description } : {}),
      chatterIds: users, cid: shortId(),
    }, { mutating: true, operation: 'create-group' });
    const result = decodedPayload(this.gateway, response, 'PutChatResponse', 'create-group');
    if (!result.chat?.id) throw new FeishuError('EFFECT_UNKNOWN', 'No group ID was returned; inspect before retrying.');
    if (Object.hasOwn(result.chat, 'type') && result.chat.type !== 2) {
      throw new FeishuError('EFFECT_UNKNOWN', 'The response did not confirm a group; inspect before retrying.',
        { chatId: String(result.chat.id) });
    }
    const chatId = String(result.chat.id);
    const botsSubmitted = [];
    for (const bot of bots) {
      try { botsSubmitted.push(await this.inviteBot({ chatId, botId: bot.id, protect: protectBots })); }
      catch (error) {
        throw new FeishuError('GROUP_CREATED_PARTIAL', 'The group was created; inspect its members before retrying.', {
          chatId, botsSubmitted, failedBotId: bot.id,
          causeCode: error instanceof FeishuError ? error.code : 'CLI_ERROR',
          causeRequestId: error instanceof FeishuError ? error.details.requestId : undefined,
        });
      }
    }
    return { status: botsSubmitted.every(bot => bot.status === 'verified') ? 'created' : 'created_protection_unconfirmed',
      chatId, requestId: response.requestId,
      membersVerified: false, bots: botsSubmitted };
  }

  async invite({ chatId, memberIds, protectBots = true }) {
    requireNumericId(chatId, 'chat ID');
    if (typeof protectBots !== 'boolean') throw new FeishuError('INVALID_ARGUMENT', 'protectBots must be a boolean.');
    const memberList = ids(memberIds, 'member ID');
    if (!memberList.length) throw new FeishuError('INVALID_ARGUMENT', 'At least one member ID is required.');
    const members = await this.resolveMembers(memberList);
    const users = members.filter(item => item.type === 'user').map(item => item.id);
    const bots = members.filter(item => item.type === 'bot');
    const submitted = [];
    if (users.length) {
      const response = await this.gateway.call(47, 'PutChatChatterRequest', {
        chatId, chatterIds: users, isInviteAtChatters: false,
      }, { mutating: true, operation: 'invite-members' });
      const result = decodedPayload(this.gateway, response, 'PutChatChatterResponse', 'invite-members');
      if (!result.chat?.id || String(result.chat.id) !== chatId) {
        throw new FeishuError('EFFECT_UNKNOWN', 'The requested group was not confirmed; inspect before retrying.',
          { requestId: response.requestId });
      }
      submitted.push({ type: 'users', memberIds: users, status: 'submitted_unconfirmed', requestId: response.requestId });
    }
    for (const bot of bots) {
      try { submitted.push({ type: 'bot', ...await this.inviteBot({ chatId, botId: bot.id, protect: protectBots }) }); }
      catch (error) {
        if (!submitted.length) throw error;
        throw new FeishuError('INVITE_PARTIAL', 'Some invitations were submitted; inspect the group before retrying.', {
          chatId, submitted, failedBotId: bot.id,
          causeCode: error instanceof FeishuError ? error.code : 'CLI_ERROR',
          causeRequestId: error instanceof FeishuError ? error.details.requestId : undefined,
        });
      }
    }
    return { status: 'submitted_unconfirmed', chatId, requested: members.length, submitted };
  }

  async members({ chatId, cursor, offset, limit = 100 }) {
    requireNumericId(chatId, 'chat ID');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new FeishuError('INVALID_ARGUMENT', 'limit must be an integer between 1 and 200.');
    }
    if (cursor != null && !/^\d+$/.test(String(cursor))) {
      throw new FeishuError('INVALID_ARGUMENT', 'cursor must be a non-negative integer.');
    }
    const response = await this.gateway.call(44, 'PullChatChattersRequest', {
      chatId, needChatters: true, limit, ...(cursor != null ? { cursor: String(cursor) } : {}),
      ...(offset ? { offset } : {}),
    }, { operation: 'list-members' });
    if (!response.packet.payload?.length) throw new FeishuError('INVALID_RESPONSE', 'No member page was returned.');
    let data;
    try { data = this.gateway.decode('PullChatChattersResponse', response.packet.payload); }
    catch { throw new FeishuError('INVALID_RESPONSE', 'The member page was unreadable.'); }
    const entries = { ...(data.chatters || {}), ...(data.updateChatters || {}) };
    return { items: Object.entries(entries).map(([key, value]) => ({
      id: String(value.id || key), name: value.name || '', type: Object.hasOwn(value, 'type') ? value.type : null,
    })), nextCursor: Object.hasOwn(data, 'nextCursor') ? data.nextCursor.toString() : null,
    nextOffset: data.nextOffset || null };
  }
}
