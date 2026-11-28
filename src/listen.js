import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync, inflateSync } from 'node:zlib';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { FeishuError, requireInt64Id } from './errors.js';
import { LarkMateClient } from './client.js';

const MAX_FRAME = 8 * 1024 * 1024;
const asString = x => x == null ? null : String(x);

// Only use tenant domains supplied by Feishu, constrained to its known domains.
function tenantHosts(tenant) {
  const name = tenant?.tenant_domain;
  const hosts = [];
  if (typeof name === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(name)) hosts.push(`${name}.larkoffice.com`);
  const full = tenant?.tenant_full_domain;
  if (typeof full === 'string' && /^(?:[a-z0-9-]+\.)+(?:feishu\.cn|larkoffice\.com|larksuite\.com)$/i.test(full)) hosts.push(full);
  return [...new Set(hosts)];
}

async function connectionUrl(gateway) {
  await gateway.authenticate();
  const userResponse = await gateway.request(`${gateway.endpoints.user}?app_id=12&_t=${Date.now()}`, {
    headers: { ...gateway.jsonHeaders(), 'x-csrf-token': gateway.jar.get('swp_csrf_token') || '' },
  }, { operation: 'listen-profile' });
  let profile; try { profile = await userResponse.json(); } catch { throw new FeishuError('INVALID_RESPONSE', 'Cannot read account information.'); }
  let appKey;
  for (const host of tenantHosts(profile?.data?.user?.tenant)) {
    try {
      const response = await gateway.request(`https://${host}/next/messenger/`, { headers: gateway.baseHeaders(), redirect: 'error' }, { operation: 'listen-config' });
      const page = await response.text();
      appKey = page.match(/appKey\s*:\s*["']([^"']+)["']/)?.[1];
      if (appKey) break;
    } catch { /* Try the next Feishu tenant host. */ }
  }
  if (!appKey) throw new FeishuError('LISTEN_CONFIG_UNAVAILABLE', 'Cannot obtain the Feishu connection configuration.');
  const localDevice = gateway.jar.get('passport_web_did') || '';
  const response = await gateway.request(`https://login.feishu.cn/suite/passport/frontier_ticket/?local_device_id=${encodeURIComponent(localDevice)}`, { headers: gateway.baseHeaders(), redirect: 'error' }, { operation: 'listen-ticket' });
  let ticket; try { ticket = await response.json(); } catch { throw new FeishuError('INVALID_RESPONSE', 'Cannot read the connection ticket.'); }
  if (typeof ticket.ticket !== 'string' || !ticket.ticket || !/^\d{1,30}$/.test(String(ticket.device_id || ''))) throw new FeishuError('AUTH_FAILED', 'Cannot obtain a connection ticket.');
  const device = String(ticket.device_id);
  const params = new URLSearchParams({ accept_encoding:'gzip', sdk_version:'7.72.8', version_code:'7.72.8', type:'sdk_main', platform:'', terminal_type:'2', device_model:'', lark_version:'7.72.0', net_status:'5', lark_env:'online', request_id:randomBytes(5).toString('hex'), aid:'1', fpid:'2', device_id:device,
    access_key:createHash('md5').update(`2${appKey}${device}f8a69f1719916z`).digest('hex'), ticket:ticket.ticket });
  return `wss://msg-frontier.feishu.cn/ws/v2?${params}`;
}

function frame(gateway, packet) {
  const now = Date.now();
  return gateway.encode('Frame', { seqid:String(Math.floor(now/1000)), logid:String(Math.floor(now/1000)), service:1, method:1,
    headers:[{key:'x-request-time',value:String(now)}], payloadType:'pb', payload:gateway.encode('Packet',packet) });
}

export function decodePush(gateway, bytes) {
  if (bytes.byteLength > MAX_FRAME) throw new FeishuError('LISTEN_FRAME_INVALID', 'The event frame is too large.');
  const envelope = gateway.decode('Frame', bytes);
  const encoding = (envelope.payloadEncoding || '').toLowerCase(), raw = envelope.payload;
  if (encoding === 'json') return { packet: null, messages: [] };
  if (!['','gzip','deflate','zlib','identity','pb'].includes(encoding)) throw new FeishuError('LISTEN_FRAME_INVALID', 'Unknown event encoding.');
  const payload = encoding === 'gzip' || (!encoding && raw?.[0] === 0x1f && raw?.[1] === 0x8b)
    ? gunzipSync(raw, { maxOutputLength: MAX_FRAME })
    : ['deflate','zlib'].includes(encoding) ? inflateSync(raw, { maxOutputLength: MAX_FRAME }) : raw;
  const packet = gateway.decode('Packet', payload);
  const messages = packet.cmd === 6 ? Object.values(gateway.decode('PushMessagesRequest', packet.payload).messages || {}) : [];
  return { packet, messages };
}

function formatMessage(gateway, m) {
  let text = null, textIncomplete = false;
  if (m.content?.length && [2, 4].includes(m.type)) {
    try {
      const c = gateway.decode(m.type === 4 ? 'TextContent' : 'PostContent', m.content);
      text = c.richText?.innerText || c.text || null;
      if (!text && c.richText?.elementIds?.length) {
        let pieces = [];
        for (const id of c.richText.elementIds) {
          const element = c.richText.elements?.dictionary?.[id];
          if (element && [1,5].includes(element.tag)) {
            const property = gateway.decode(element.tag === 1 ? 'TextProperty' : 'AtProperty', element.property);
            if (typeof property.content === 'string') pieces.push(property.content); else textIncomplete = true;
          } else textIncomplete = true;
        }
        text = pieces.join('') || null;
      }
    } catch { textIncomplete = true; }
  }
  return { kind:'message', id:asString(m.id), chatId:asString(m.chatId), senderId:asString(m.fromId), position:Number.isInteger(m.position)?m.position:null,
    type:m.type, text, textIncomplete, createTime:asString(m.createTime), rootId:asString(m.rootId), parentId:asString(m.parentId) };
}

export async function listen({ gateway, chatIds = [], output = process.stdout, log = process.stderr, signal, WebSocketImpl = WebSocket }) {
  if (!Array.isArray(chatIds)) throw new FeishuError('INVALID_ARGUMENT', 'chat IDs must be a list.');
  const selected = new Set(chatIds.map(id => requireInt64Id(id, 'chat ID')));
  const global = selected.size === 0;
  const client = new LarkMateClient(gateway), seen = new Set(), seenOrder = [], positions = new Map();
  const emit = async value => { if (!output.write(`${JSON.stringify(value)}\n`)) await once(output, 'drain'); };
  const remember = id => { if (!id || seen.has(id)) return false; seen.add(id); seenOrder.push(id); if (seenOrder.length > 10000) seen.delete(seenOrder.shift()); return true; };
  const writeMessage = async message => { if ((!global && !selected.has(message.chatId)) || !remember(message.id)) return;
    if (typeof message.chatId === 'string' && /^[1-9]\d{0,18}$/.test(message.chatId) && Number.isInteger(message.position)) positions.set(message.chatId, Math.max(positions.get(message.chatId) ?? 0, message.position)); await emit(message); };
  for (const chatId of selected) { const info = await client.chatInfo(chatId); if (!Number.isInteger(info.lastMessagePosition)) throw new FeishuError('POSITION_UNAVAILABLE', 'Cannot read the initial message position.'); positions.set(chatId, info.lastMessagePosition); }
  const backfill = async () => { for (const chatId of (global ? [...positions.keys()] : selected)) {
    let latest;
    try { latest = (await client.chatInfo(chatId)).lastMessagePosition; }
    catch (error) { await emit({kind:'gap',chatId,reason:'position_unavailable',code:error.code || 'READ_FAILED'}); continue; }
    const from = positions.get(chatId) + 1;
    if (!Number.isInteger(latest)) { await emit({ kind:'gap', chatId, reason:'position_unavailable' }); continue; }
    if (latest - from >= 10000) { await emit({ kind:'gap', chatId, reason:'backfill_limit', fromPosition:from, throughPosition:latest }); positions.set(chatId,latest); continue; }
    try {
      for (let start=from; start<=latest; start+=100) {
        const page = await client.history({chatId,start,limit:Math.min(100,latest-start+1)});
        for (const m of page.items) await writeMessage({kind:'message',chatId,...m,backfill:true});
        if (page.omittedPositions) await emit({kind:'gap',chatId,reason:'positions_unavailable',start,count:page.omittedPositions});
      }
    } catch (error) { await emit({kind:'gap',chatId,reason:'backfill_failed',code:error.code || 'READ_FAILED'}); continue; }
    positions.set(chatId, Math.max(positions.get(chatId), latest));
  } };
  let attempt = 0;
  while (!signal?.aborted) {
    let socket, heartbeat, pending = Promise.resolve(), connected = false, failure = null, reported = false;
    try {
      const url = await connectionUrl(gateway);
      socket = new WebSocketImpl(url); socket.binaryType = 'arraybuffer';
      await new Promise((resolve,reject) => {
        const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort',abort); };
        const abort = () => { cleanup(); socket.close(); reject(new FeishuError('LISTEN_STOPPED','Listener stopped.')); };
        const timeout = setTimeout(() => { cleanup(); socket.close(); reject(new FeishuError('LISTEN_CONNECT_FAILED','Connection timed out.')); },15000);
        socket.addEventListener('open',()=>{cleanup();resolve();},{once:true});
        socket.addEventListener('error',()=>{cleanup();reject(new FeishuError('LISTEN_CONNECT_FAILED','Feishu rejected the message connection.'));},{once:true});
        socket.addEventListener('close',()=>{cleanup();reject(new FeishuError('LISTEN_CONNECT_FAILED','Feishu closed the message connection.'));},{once:true});
        signal?.addEventListener('abort',abort,{once:true});
      });
      connected = true; attempt = 0;
      const closed = new Promise(resolve => socket.addEventListener('close',resolve,{once:true}));
      const stop = () => socket.close(); signal?.addEventListener('abort',stop,{once:true});
      const initialBackfill = backfill();
      pending = initialBackfill;
      let queued = 0, queuedBytes = 0;
      socket.addEventListener('message', event => {
        const size = event.data?.byteLength;
        if (!Number.isSafeInteger(size) || size > MAX_FRAME || ++queued > 500 || (queuedBytes += size) > 16 * 1024 * 1024) { failure = new FeishuError('LISTEN_BACKPRESSURE', 'The event queue is full or a frame is invalid.'); socket.close(); return; }
        pending = pending.then(async () => {
          const {packet,messages} = decodePush(gateway,new Uint8Array(event.data));
          if (!packet) return;
          if (packet.sid) socket.send(frame(gateway,{cmd:1,payloadType:1,sid:packet.sid,payload:Uint8Array.of(8,0)}));
          if (packet.cmd === 6000) {
            const sids = [...new Set([packet.sid, ...(packet.compactedSids || []).map(String)].filter(Boolean))];
            if (!sids.length) { await emit({kind:'gap',reason:'missing_push_identifiers'}); return; }
            try {
              const result = await gateway.call(12001,'PullPacketsBySidsRequest',{sids},{version:'5.7.0',operation:'listen-pull-packets'});
              const packets = gateway.decode('PullPacketsBySidsResponse',result.packet.payload).packets || {};
              for (const p of Object.values(packets)) if (p.cmd === 6) for (const m of Object.values(gateway.decode('PushMessagesRequest',p.payload).messages || {})) await writeMessage(formatMessage(gateway,m));
              if (sids.some(sid => !Object.hasOwn(packets,sid))) await emit({kind:'gap',reason:'missing_push_packets'});
            } catch { await emit({kind:'gap',reason:'push_pull_failed'}); }
            return;
          }
          if (packet.cmd === 134) {
            try {
              const batch = gateway.decode('PushBatchCopyMessages',packet.payload);
              if (batch.lastMessage?.id) await writeMessage(formatMessage(gateway,batch.lastMessage));
              const ids = [...new Set((batch.messageIds || []).map(String))].filter(id=>id!==String(batch.lastMessage?.id || ''));
              if (ids.length) {
                const result = await gateway.call(8,'PullMessagesByIdsRequest',{messageIds:ids},{version:'5.7.0',operation:'listen-pull-messages'});
                const found = gateway.decode('PullMessagesByIdsResponse',result.packet.payload).messages || {};
                for (const m of Object.values(found)) await writeMessage(formatMessage(gateway,m));
                if (ids.some(id => !Object.hasOwn(found,id))) await emit({kind:'gap',reason:'missing_forwarded_messages'});
              }
            } catch { await emit({kind:'gap',reason:'forwarded_messages_pull_failed'}); }
            return;
          }
          for (const m of messages) await writeMessage(formatMessage(gateway,m));
        }).catch(error => { failure = error; socket.close(); }).finally(() => { queued--; queuedBytes -= size; });
      });
      heartbeat = setInterval(()=>{ try { if(socket.readyState === 1) socket.send(frame(gateway,{cmd:4,payloadType:1})); } catch { socket.close(); } },30000);
      log.write('LarkMate: message listener connected.\n');
      await initialBackfill; await closed; await pending; signal?.removeEventListener('abort',stop);
      if (failure) throw failure;
    } catch (error) {
      if (signal?.aborted) break;
      await emit({kind:'gap',reason:connected?'connection_interrupted':'connection_failed',code:error.code || 'LISTEN_FAILED'});
      reported = true;
    } finally { clearInterval(heartbeat); if (socket && socket.readyState < 2) socket.close(); }
    if (signal?.aborted) break;
    if (connected && !reported) await emit({kind:'gap',reason:'connection_interrupted'});
    if (global && connected) await emit({kind:'gap',reason:'global_coverage_unknown'});
    try { await delay(Math.min(30000,1000 * 2**Math.min(attempt++,5)), undefined, { signal }); } catch (error) { if (!signal?.aborted) throw error; }
  }
}
