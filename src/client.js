import { FeishuError, requireNumericId, requireText } from './errors.js';
import { shortId } from './gateway.js';

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

export class FeishuUserClient {
  constructor(gateway) { this.gateway = gateway; }

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
      return { id: String(message.id || ''), position: Number(position),
        senderId: message.fromId || '', type: message.type, text };
    }).sort((a, b) => a.position - b.position);
    return { items, requestedPositions: positions.length,
      omittedPositions: positions.length - items.length, hasMore: Object.hasOwn(data, 'hasMore') ? data.hasMore : null };
  }

  async send({ chatId, text, mentions = [] }) {
    requireNumericId(chatId, 'chat ID');
    requireText(text, 'text');
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
