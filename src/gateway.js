import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { readFile } from 'node:fs/promises';
import { FeishuError } from './errors.js';

const protoFile = fileURLToPath(new URL('../proto/lark.proto', import.meta.url));
const calendarProtoFile = fileURLToPath(new URL('../proto/calendar-schema.json', import.meta.url));
let calendarProtoPromise;
const todoProtoFile = fileURLToPath(new URL('../proto/todo-schema.json', import.meta.url));
let todoProtoPromise;
const defaults = {
  csrf: 'https://internal-api-lark-api.feishu.cn/accounts/csrf',
  user: 'https://internal-api-lark-api.feishu.cn/accounts/web/user',
  gateway: 'https://internal-api-lark-api.feishu.cn/im/gateway/',
  botApi: 'https://open.feishu.cn/open-apis/chatbot/api/',
  file: 'https://internal-api-lark-file.feishu.cn',
};

export const shortId = () => randomBytes(8).toString('hex').slice(0, 10);

function parseCookies(value) {
  const jar = new Map();
  for (const item of value.split(';')) {
    const i = item.indexOf('=');
    if (i > 0) jar.set(item.slice(0, i).trim(), item.slice(i + 1).trim());
  }
  return jar;
}

export class Gateway {
  constructor({ cookie, fetchImpl = fetch, endpoints = defaults, timeoutMs = 15000 } = {}) {
    this.jar = parseCookies(cookie);
    this.fetchImpl = fetchImpl;
    this.endpoints = endpoints;
    this.timeoutMs = timeoutMs;
    this.proto = null;
    this.user = null;
  }

  baseHeaders() {
    return {
      cookie: [...this.jar].map(([key, value]) => `${key}=${value}`).join('; '),
      origin: 'https://www.feishu.cn',
      referer: 'https://www.feishu.cn/',
      'accept-language': 'zh-CN,zh;q=0.9',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };
  }

  jsonHeaders() {
    return {
      ...this.baseHeaders(),
      accept: 'application/json, text/plain, */*',
      'x-app-id': '12',
      'x-api-version': '2',
      'x-device-info': 'platform=websdk',
      'x-lgw-os-type': '1',
      'x-lgw-terminal-type': '2',
      'x-terminal-type': '2',
    };
  }

  absorbCookies(headers) {
    for (const row of headers.getSetCookie?.() || []) {
      const first = row.split(';', 1)[0];
      const separator = first.indexOf('=');
      if (separator > 0) this.jar.set(first.slice(0, separator), first.slice(separator + 1));
    }
  }

  async request(url, options, { operation, mutating = false } = {}) {
    let response;
    try {
      response = await this.fetchImpl(url, { ...options, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new FeishuError(mutating ? 'EFFECT_UNKNOWN' : 'REQUEST_FAILED',
        mutating ? 'Request outcome is unknown; inspect the chat before retrying.' : 'The Feishu request failed.',
        { operation });
    }
    if (!response.ok) {
      throw new FeishuError(mutating ? 'EFFECT_UNKNOWN' : 'REQUEST_FAILED',
        mutating ? 'Request outcome is unknown; inspect the chat before retrying.' : 'The Feishu request was rejected.',
        { operation, httpStatus: response.status });
    }
    return response;
  }

  async authenticate() {
    if (this.user) return this.user;
    this.proto ||= await protobuf.load(protoFile);
    const csrf = await this.request(this.endpoints.csrf, {
      method: 'POST', headers: { ...this.jsonHeaders(), 'x-request-id': randomUUID() },
    }, { operation: 'authenticate' });
    this.absorbCookies(csrf.headers);
    const response = await this.request(`${this.endpoints.user}?app_id=12&_t=${Date.now()}`, {
      headers: {
        ...this.jsonHeaders(),
        'x-csrf-token': this.jar.get('swp_csrf_token') || '',
        'x-request-id': randomUUID(),
      },
    }, { operation: 'authenticate' });
    let body;
    try { body = await response.json(); } catch { /* classified below */ }
    const user = body?.data?.user;
    if (!user?.id) throw new FeishuError('AUTH_FAILED', 'The user Cookie is invalid or expired.');
    this.user = { id: String(user.id), name: user.name || null };
    return this.user;
  }

  encode(name, data) {
    const type = (/^(calendar_web|calendar_events|calendar_entities|calendars)\./.test(name) ? this.calendarProto : name.startsWith('todo.') || name.startsWith('todo_entities.') ? this.todoProto : this.proto).lookupType(name);
    const message = type.fromObject(data);
    const error = type.verify(message);
    if (error) throw new FeishuError('PROTOCOL_INPUT_INVALID', `Invalid ${name} payload.`);
    return type.encode(message).finish();
  }

  decode(name, bytes) {
    return (/^(calendar_web|calendar_events|calendar_entities|calendars)\./.test(name) ? this.calendarProto : name.startsWith('todo.') || name.startsWith('todo_entities.') ? this.todoProto : this.proto).lookupType(name).decode(bytes);
  }

  async uploadRequest(path, body, contentType) {
    const response = await this.request(this.endpoints.file + path, {
      method: 'POST', redirect: 'manual', headers: { ...this.baseHeaders(), 'content-type': contentType }, body,
    }, { operation: 'upload-file', mutating: true });
    try { return new Uint8Array(await response.arrayBuffer()); }
    catch { throw new FeishuError('UPLOAD_FAILED', 'File upload response was unreadable.'); }
  }

  async botApi(action, body, { mutating = false, operation } = {}) {
    if (!['SetBotAddConf', 'UpdateAppBotInfo', 'fetch_bot_conf_resource'].includes(action)) {
      throw new FeishuError('INVALID_ARGUMENT', 'Unsupported bot operation.');
    }
    await this.authenticate();
    const requestId = randomUUID();
    const response = await this.request(`${this.endpoints.botApi}${action}`, {
      method: 'POST', redirect: 'manual',
      headers: {
        ...this.baseHeaders(), 'content-type': 'text/plain;charset=UTF-8',
        'x-csrf-token': this.jar.get('swp_csrf_token') || '', 'x-request-id': requestId,
      },
      body: JSON.stringify({ ...body, i18n: 'zh-CN' }),
    }, { mutating, operation });
    let data;
    try { data = await response.json(); } catch { /* classified below */ }
    if (!data || typeof data.code !== 'number') {
      throw new FeishuError(mutating ? 'EFFECT_UNKNOWN' : 'INVALID_RESPONSE',
        mutating ? 'The response was unreadable; inspect the group before retrying.' : 'The bot response was unreadable.',
        { operation, requestId });
    }
    if (data.code !== 0) {
      throw new FeishuError('BOT_API_REJECTED', 'Feishu rejected the bot operation.',
        { operation, status: data.code, requestId });
    }
    return { data, requestId };
  }

  async ensureTodoProto() {
    todoProtoPromise ||= readFile(todoProtoFile, 'utf8').then(text => protobuf.Root.fromJSON(JSON.parse(text)));
    this.todoProto = await todoProtoPromise;
    return this.todoProto;
  }

  async ensureCalendarProto() {
    calendarProtoPromise ||= readFile(calendarProtoFile, 'utf8').then(text => protobuf.Root.fromJSON(JSON.parse(text)));
    this.calendarProto = await calendarProtoPromise;
    return this.calendarProto;
  }

  async call(command, requestType, body, { version = '2.7.0', mutating = false, operation } = {}) {
    await this.authenticate();
    if (requestType.startsWith('todo.')) await this.ensureTodoProto();
    if (/^(calendar_web|calendar_events|calendar_entities|calendars)\./.test(requestType)) await this.ensureCalendarProto();
    const requestId = randomUUID();
    const packet = this.encode('Packet', {
      payloadType: 1, cmd: command, cid: requestId,
      payload: this.encode(requestType, body),
    });
    const response = await this.request(this.endpoints.gateway, {
      method: 'POST',
      headers: {
        ...this.baseHeaders(), accept: '*/*', 'content-type': 'application/x-protobuf',
        locale: 'zh_CN', 'x-appid': '161471', 'x-command': String(command),
        'x-command-version': version, 'x-lgw-os-type': '1', 'x-lgw-terminal-type': '2',
        'x-request-id': requestId, 'x-source': 'web', 'x-web-version': '3.9.32',
      },
      body: packet,
    }, { mutating, operation });
    let decoded;
    try { decoded = this.decode('Packet', new Uint8Array(await response.arrayBuffer())); }
    catch {
      throw new FeishuError(mutating ? 'EFFECT_UNKNOWN' : 'INVALID_RESPONSE',
        mutating ? 'The response was unreadable; inspect the chat before retrying.' : 'The gateway response was unreadable.',
        { operation, requestId });
    }
    if (Object.hasOwn(decoded, 'status') && decoded.status != null && decoded.status !== 0) {
      throw new FeishuError('GATEWAY_REJECTED', 'The gateway rejected the request.',
        { operation, status: decoded.status, requestId });
    }
    return { packet: decoded, requestId };
  }
}
