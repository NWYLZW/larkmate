import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { FeishuError } from './errors.js';
import { minuteToken } from './minutes.js';
import { handleFileRequest, brokerUpload, brokerDownload } from './agent-files.js';

// The socket policy is enforced in this process, never by the calling agent.
// An explicit mapping prevents callers from reaching arbitrary object methods.
const routes = {
  status: ['client', 'status', 'global'], search: ['client', 'search', 'global'],
  'calendars': ['calendar','calendars','global'], 'calendar-search': ['calendar','searchCalendars','global'],
  'calendar-events': ['calendar','events','global'], 'event-get': ['calendar','event','global'], 'calendar-rooms': ['calendar','rooms','global'],
  'event-create': ['calendar','createEvent','global'], 'event-update': ['calendar','updateEvent','global'], 'event-delete': ['calendar','deleteEvent','global'],
  'event-share': ['calendar','share','allChats'], 'event-reply': ['calendar','reply','global'], 'calendar-create': ['calendar','createCalendar','global'], 'calendar-update': ['calendar','updateCalendar','global'],
  'calendar-delete': ['calendar','deleteCalendar','global'], 'calendar-subscribe': ['calendar','subscription','global'], 'calendar-unsubscribe': ['calendar','subscription','global'],
  'group-query': ['feeds', 'query', 'allChats'],
  'task-center': ['tasks', 'center', 'global'], 'tasks-list': ['tasks', 'list', 'global'],
  'task-search': ['tasks', 'search', 'global'], 'task-get': ['tasks', 'get', 'global'],
  'task-create': ['tasks', 'create', 'global'], 'task-update': ['tasks', 'update', 'global'],
  'task-complete': ['tasks', 'complete', 'global'], 'task-reopen': ['tasks', 'complete', 'global'], 'task-delete': ['tasks', 'delete', 'global'],
  'sidebar-list': ['sidebar', 'list', 'global'], 'sidebar-set': ['sidebar', 'set', 'allChats'],
  'search-messages': ['client', 'searchMessages', 'allChats'], chats: ['client', 'chats', 'allChats'],
  pinned: ['controls', 'pinned', 'allChats'], marked: ['controls', 'marked', 'allChats'],
  labels: ['controls', 'labels', 'allChats'], 'label-chats': ['controls', 'labelChats', 'allChats'],
  'label-create': ['controls', 'createLabel', 'allChats'], 'label-rename': ['controls', 'renameLabel', 'allChats'],
  'label-delete': ['controls', 'deleteLabel', 'allChats'],
  'label-add': ['controls', 'labelChat', 'labelTrue'], 'label-remove': ['controls', 'labelChat', 'labelFalse'],
  favorites: ['client', 'favorites', 'allChats'],
  'chat-open': ['client', 'openChat', 'allChats'],
  'chat-info': ['client', 'chatInfo', 'chatArg'], 'chat-state': ['controls', 'state', 'chatArg'],
  history: ['client', 'historyPages', 'chatObject'], 'messages-export': ['client', 'historyPages', 'chatObject'],
  'group-members': ['client', 'members', 'chatObject'], 'group-bot-info': ['client', 'botProtection', 'chatObject'],
  'group-update': ['client', 'updateGroup', 'chatObject'], 'group-dissolve': ['client', 'dissolveGroup', 'chatArg'],
  'group-create': ['client', 'createGroup', 'allChats'], 'group-invite': ['client', 'invite', 'allChats'],
  'group-bot-protection': ['client', 'setBotProtection', 'allChats'],
  'message-link': ['client', 'messageLink', 'allChats'], 'message-edit': ['client', 'editMessage', 'allChats'],
  'message-forward': ['client', 'forwardMessage', 'allChats'], 'message-recall': ['client', 'recallMessage', 'allChats'],
  'favorite-add': ['client', 'favoriteMessage', 'allChats'], 'favorite-remove': ['client', 'removeFavorite', 'allChats'],
  'reaction-add': ['client', 'reaction', 'reactionAdd'], 'reaction-remove': ['client', 'reaction', 'reactionRemove'],
  send: ['client', 'send', 'send'],
  pin: ['controls', 'pin', 'chatTrue'], unpin: ['controls', 'pin', 'chatFalse'],
  mark: ['controls', 'mark', 'chatTrue'], unmark: ['controls', 'mark', 'chatFalse'],
  mute: ['controls', 'setMute', 'chatTrue'], unmute: ['controls', 'setMute', 'chatFalse'],
  done: ['controls', 'setDone', 'chatTrue'], inbox: ['controls', 'setDone', 'chatFalse'],
  box: ['controls', 'setBox', 'chatTrue'], unbox: ['controls', 'setBox', 'chatFalse'],
  read: ['controls', 'setRead', 'chatArg'], unread: ['controls', 'setUnread', 'chatArg'],
  'minutes-list': ['minutes', 'list', 'allMinutes'], 'minutes-export': ['minutes', 'transcript', 'minute'],
  'minutes-access-info': ['minutes', 'accessInfo', 'minute'], 'minutes-request-access': ['minutes', 'requestAccess', 'minute'],
  'send-file': ['files', 'upload', 'file'], 'send-image': ['files', 'upload', 'file'],
  'download-file': ['files', 'download', 'file'],
};
const writes = new Set(['send', 'pin', 'unpin', 'mark', 'unmark', 'mute', 'unmute', 'done', 'inbox', 'box', 'unbox', 'read', 'unread',
  'label-create', 'label-rename', 'label-delete', 'label-add', 'label-remove', 'chat-open', 'group-create', 'group-invite',
  'group-update', 'group-dissolve', 'group-bot-protection', 'message-edit', 'message-forward', 'message-recall', 'favorite-add',
  'favorite-remove', 'reaction-add', 'reaction-remove', 'minutes-request-access', 'send-file', 'send-image', 'sidebar-set', 'task-create', 'task-update', 'task-complete', 'task-reopen', 'task-delete', 'event-create', 'event-update', 'event-delete', 'event-share', 'event-reply', 'calendar-create', 'calendar-update', 'calendar-delete', 'calendar-subscribe', 'calendar-unsubscribe']);

export function brokerCommands() {
  return Object.entries(routes).map(([command, [, , scope]]) => ({ command,
    scope: scope === 'global' ? 'global' : scope === 'allMinutes' ? 'global-and-all-minutes'
      : ['allChats', 'labelTrue', 'labelFalse', 'reactionAdd', 'reactionRemove'].includes(scope) ? 'global-and-all-chats'
        : scope === 'minute' ? 'minute' : 'chat', mutating: writes.has(command) }));
}

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const only = (value, keys) => object(value) && Object.keys(value).every(k => keys.includes(k));
const denied = () => { throw new FeishuError('POLICY_DENIED', 'This action or resource is not permitted by the broker policy.'); };
const invalidPolicy = () => { throw new FeishuError('POLICY_INVALID', 'The broker policy is invalid.'); };
const numeric = value => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;

export function parsePolicy(raw) {
  if (!only(raw, ['version', 'allow', 'chatIds', 'minuteTokens', 'allowAllChats', 'allowAllMinutes', 'allowGlobal', 'maxFileBytes']) || raw.version !== 1 || !Array.isArray(raw.allow)) invalidPolicy();
  if (raw.allow.some(x => typeof x !== 'string' || !Object.hasOwn(routes, x)) || new Set(raw.allow).size !== raw.allow.length) invalidPolicy();
  const chatIds = Object.hasOwn(raw, 'chatIds') ? raw.chatIds : [];
  const minuteTokens = Object.hasOwn(raw, 'minuteTokens') ? raw.minuteTokens : [];
  if (!Array.isArray(chatIds) || chatIds.some(x => !numeric(x)) || new Set(chatIds).size !== chatIds.length) invalidPolicy();
  if (!Array.isArray(minuteTokens) || minuteTokens.some(x => typeof x !== 'string' || !/^[A-Za-z0-9_-]{10,128}$/.test(x)) || new Set(minuteTokens).size !== minuteTokens.length) invalidPolicy();
  for (const key of ['allowAllChats', 'allowAllMinutes', 'allowGlobal']) if (Object.hasOwn(raw, key) && typeof raw[key] !== 'boolean') invalidPolicy();
  const maxFileBytes = Object.hasOwn(raw, 'maxFileBytes') ? raw.maxFileBytes : 100 * 1024 * 1024;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 100 * 1024 * 1024) invalidPolicy();
  return Object.freeze({ version: 1, allow: Object.freeze([...raw.allow]), chatIds: Object.freeze([...chatIds]),
    minuteTokens: Object.freeze([...minuteTokens]), allowAllChats: raw.allowAllChats === true,
    allowAllMinutes: raw.allowAllMinutes === true, allowGlobal: raw.allowGlobal === true, maxFileBytes });
}

export async function loadPolicy(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) invalidPolicy();
  let data, handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536 || (stat.uid !== process.getuid?.() && stat.uid !== 0) || (stat.mode & 0o022)) throw new Error();
    data = await handle.readFile('utf8');
  } catch { throw new FeishuError('POLICY_UNAVAILABLE', 'Cannot read a protected broker policy.'); }
  finally { await handle?.close(); }
  if (Buffer.byteLength(data) > 65536) invalidPolicy();
  try { return parsePolicy(JSON.parse(data)); }
  catch (error) { if (error instanceof FeishuError) throw error; invalidPolicy(); }
}

export async function createBrokerToken(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new FeishuError('INVALID_ARGUMENT', 'The token file path must be absolute.');
  try { await writeFile(path, `${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { throw new FeishuError('BROKER_TOKEN_WRITE_FAILED', error.code === 'EEXIST' ? 'Token file already exists; choose a new path.' : 'Cannot create the token file.'); }
}

export async function loadBrokerToken(path, { owner = false } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new FeishuError('BROKER_TOKEN_UNAVAILABLE', 'An absolute broker token file path is required.');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256 || (owner && ((stat.uid !== process.getuid?.() && stat.uid !== 0) || (stat.mode & 0o022)))) throw new Error();
    const token = (await handle.readFile('utf8')).trim();
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error();
    return token;
  } catch { throw new FeishuError('BROKER_TOKEN_UNAVAILABLE', 'Cannot read a valid, protected broker token file.'); }
  finally { await handle?.close(); }
}

export function authorize(policy, request) {
  if (!only(request, ['command', 'service', 'method', 'args']) || typeof request.command !== 'string' || !Object.hasOwn(routes, request.command) || !policy.allow.includes(request.command)) denied();
  const [service, method, scope] = routes[request.command];
  if (request.service !== service || request.method !== method || !Array.isArray(request.args)) denied();
  const args = request.args;
  const chatAllowed = id => numeric(id) && (policy.allowAllChats || policy.chatIds.includes(id));
  if (scope === 'global' && !policy.allowGlobal) denied();
  if (['calendar-subscribe', 'calendar-unsubscribe'].includes(request.command) && (args.length !== 1 || !object(args[0]) || args[0].subscribe !== (request.command === 'calendar-subscribe'))) denied();
  if (['task-complete', 'task-reopen'].includes(request.command) && (args.length !== 1 || !object(args[0]) || args[0].completed !== (request.command === 'task-complete'))) denied();
  if (['allChats', 'labelTrue', 'labelFalse', 'reactionAdd', 'reactionRemove'].includes(scope) && (!policy.allowGlobal || !policy.allowAllChats)) denied();
  if (scope === 'allMinutes' && (!policy.allowGlobal || !policy.allowAllMinutes)) denied();
  if (scope === 'file' && (args.length !== 1 || !only(args[0], method === 'download' ? ['chatId', 'messageId', 'key', 'position'] : ['chatId']) || !chatAllowed(args[0].chatId))) denied();
  if (['labelTrue', 'labelFalse'].includes(scope) && (args.length !== 3 || args[2] !== (scope === 'labelTrue'))) denied();
  if (['reactionAdd', 'reactionRemove'].includes(scope) && (args.length !== 1 || !only(args[0], ['messageId', 'emoji', 'remove']) || args[0].remove !== (scope === 'reactionRemove'))) denied();
  if (['chatArg', 'chatTrue', 'chatFalse'].includes(scope)) {
    if (!chatAllowed(args[0])) denied();
    if (scope === 'chatArg' && args.length !== 1) denied();
    if (scope === 'chatTrue' && (args.length !== 2 || args[1] !== true)) denied();
    if (scope === 'chatFalse' && (args.length !== 2 || args[1] !== false)) denied();
  }
  if (scope === 'chatObject' || scope === 'send') {
    if (args.length !== 1 || !object(args[0]) || !chatAllowed(args[0].chatId)) denied();
    const keys = scope === 'send' ? ['chatId', 'text', 'mentions', 'replyTo', 'replyRoot']
      : method === 'historyPages' ? ['chatId', 'limit', 'start', 'pages', 'query', 'sender', 'after', 'before']
        : method === 'members' ? ['chatId', 'cursor', 'offset', 'limit']
          : method === 'updateGroup' ? ['chatId', 'name', 'description'] : ['chatId', 'botId'];
    if (!only(args[0], keys)) denied();
    // A reply ID may refer to another chat, and mentions can notify additional users.
    if (scope === 'send' && !policy.allowAllChats && (args[0].replyTo || args[0].replyRoot || (args[0].mentions?.length ?? 0) !== 0)) denied();
  }
  if (scope === 'minute') {
    if (args.length < 1 || args.length > 2 || typeof args[0] !== 'string') denied();
    let token; try { token = minuteToken(args[0]); } catch { denied(); }
    if (!policy.allowAllMinutes && !policy.minuteTokens.includes(token)) denied();
    if (method === 'requestAccess' && args.length === 2 && !only(args[1], ['reason'])) denied();
    if (method !== 'requestAccess' && args.length !== 1) denied();
  }
  return { service, method, args };
}

function safeError(error) {
  return error instanceof FeishuError ? { code: error.code, message: error.message, ...error.details }
    : { code: 'BROKER_ERROR', message: 'The broker could not complete the request.' };
}

export function createBrokerHandler({ policy, token, getServices }) {
  let transfers = 0;
  return async (req, res) => {
    const answer = (status, body) => { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'connection': 'close' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || !['/v1/call', '/v1/file'].includes(req.url)) return answer(400, { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid broker request.' } });
    const authorization = req.headers.authorization || '';
    const provided = Buffer.from(authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
    const expected = Buffer.from(token);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return answer(401, { ok: false, error: { code: 'BROKER_AUTH_FAILED', message: 'Invalid broker token.' } });
    if (req.url === '/v1/file') {
      if (transfers >= 2) return answer(429, { ok: false, error: { code: 'BROKER_BUSY', message: 'Too many file transfers.' } });
      transfers++;
      try { await handleFileRequest({ req, res, policy, getServices, authorize, answer }); }
      finally { transfers--; }
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return answer(400, { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid broker request.' } });
    let chunks = [], size = 0, command, dispatched = false;
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new FeishuError('INVALID_REQUEST', 'Broker request is too large.'); chunks.push(chunk); }
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      command = request?.command;
      if (only(request, ['command']) && request.command === 'broker-info') return answer(200, { ok: true, policy });
      const { service, method, args } = authorize(policy, request);
      if (service === 'files') denied(); // File bytes use a separate endpoint, never owner-local paths.
      const services = await getServices();
      dispatched = true;
      const data = await services[service][method](...args);
      answer(200, { ok: true, data });
    } catch (error) {
      const failure = dispatched && writes.has(command) && !(error instanceof FeishuError)
        ? new FeishuError('EFFECT_UNKNOWN', 'The broker could not confirm the result; inspect before retrying.') : error;
      answer(400, { ok: false, error: safeError(failure) });
    }
  };
}

export async function startBroker({ socketPath, policy, token, getServices }) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new FeishuError('BROKER_TOKEN_UNAVAILABLE', 'A valid broker token is required.');
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath) || socketPath.endsWith('/')) throw new FeishuError('INVALID_ARGUMENT', 'The broker socket path must be absolute.');
  let parent;
  try { parent = await realpath(dirname(socketPath)); } catch { throw new FeishuError('BROKER_SOCKET_INVALID', 'The socket parent directory must exist.'); }
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.uid !== process.getuid?.() || (parentInfo.mode & 0o022)) throw new FeishuError('BROKER_SOCKET_INVALID', 'The socket parent must be owned by the broker user and not writable by group or others.');
  const actualPath = join(parent, socketPath.slice(dirname(socketPath).length + 1));
  try { await lstat(actualPath); throw new FeishuError('BROKER_SOCKET_EXISTS', 'The socket path already exists; choose another path.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const server = http.createServer(createBrokerHandler({ policy, token, getServices }));
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxConnections = 32;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 1;
  const oldMask = process.umask(0o077);
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(actualPath, resolve); }); }
  finally { process.umask(oldMask); }
  let inode;
  try { await chmod(actualPath, 0o600); inode = await lstat(actualPath); }
  catch { await new Promise(resolve => server.close(resolve)); throw new FeishuError('BROKER_SOCKET_INVALID', 'Could not protect the broker socket.'); }
  const close = async () => {
    await new Promise(resolve => server.close(resolve));
    try { const now = await lstat(actualPath); if (now.isSocket() && now.dev === inode.dev && now.ino === inode.ino) await unlink(actualPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  return { server, close, socketPath: actualPath };
}

export async function brokerCall(socketPath, request, tokenFile) {
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) throw new FeishuError('INVALID_ARGUMENT', 'The broker socket path must be absolute.');
  const token = await loadBrokerToken(tokenFile);
  const failed = () => writes.has(request.command)
    ? new FeishuError('EFFECT_UNKNOWN', 'The broker connection failed; inspect the result before retrying.')
    : new FeishuError('BROKER_UNAVAILABLE', 'Cannot connect to the broker.');
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: 'POST', path: '/v1/call', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, timeout: 120000 }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 32 * 1024 * 1024) req.destroy(); else chunks.push(chunk); });
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!body.ok) {
            const { code, message, ...details } = object(body.error) ? body.error : {};
            return reject(new FeishuError(code || 'BROKER_ERROR', message || 'Broker request failed.', details));
          }
          resolve(request.command === 'broker-info' ? body.policy : body.data);
        } catch { reject(writes.has(request.command) ? failed() : new FeishuError('BROKER_INVALID_RESPONSE', 'The broker returned an invalid response.')); }
      });
      res.on('error', () => reject(failed()));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => reject(failed()));
    req.end(JSON.stringify(request));
  });
}

export function brokerProxy(socketPath, service, getCommand, tokenFile) {
  return new Proxy({}, { get(_target, method) {
    if (method === 'then' || typeof method !== 'string') return undefined;
    if (service === 'client' && ['sendFile', 'sendImage'].includes(method)) return options => brokerUpload(socketPath, tokenFile, getCommand(), options);
    if (service === 'client' && method === 'downloadFile') return options => brokerDownload(socketPath, tokenFile, options);
    return (...args) => brokerCall(socketPath, { command: getCommand(), service, method, args }, tokenFile);
  } });
}
