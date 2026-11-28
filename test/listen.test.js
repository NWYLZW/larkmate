import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { Gateway } from '../src/gateway.js';
import { LarkMateClient } from '../src/client.js';
import { decodePush, listen } from '../src/listen.js';

async function gateway() {
  const g = new Gateway({ cookie: 'session=test' });
  const protobuf = (await import('protobufjs')).default;
  g.proto = await protobuf.load(new URL('../proto/lark.proto', import.meta.url).pathname);
  g.authenticate = async () => ({ id:'7' });
  g.request = async url => ({ json:async () => url.includes('frontier_ticket') ? {ticket:'ticket',device_id:'42'} : {data:{user:{tenant:{tenant_domain:'unit-test'}}}}, text:async () => `appKey: "public-test-key"` });
  return g;
}
function push(g, chatId, id, text) {
  const property = g.encode('TextProperty',{content:text});
  const content = g.encode('TextContent',{richText:{elementIds:['a'],elements:{dictionary:{a:{tag:1,property}}}}});
  const payload = g.encode('PushMessagesRequest',{messages:{[id]:{id,chatId,fromId:'7',type:4,content,position:2}}});
  return g.encode('Frame',{payload:g.encode('Packet',{cmd:6,payloadType:1,sid:'s',payload})});
}

test('push decoder enforces the frame size limit', async () => {
  const g = await gateway();
  assert.throws(() => decodePush(g,new Uint8Array(8*1024*1024+1)), {code:'LISTEN_FRAME_INVALID'});
  assert.equal(decodePush(g,push(g,'123','5','hello')).messages.length,1);
  const inner=g.decode('Frame',push(g,'123','5','hello')).payload;
  assert.equal(decodePush(g,g.encode('Frame',{payload:gzipSync(inner)})).messages.length,1);
});

test('listener emits selected messages once and reports incomplete push types', async () => {
  const g = await gateway(), controller = new AbortController(), output = new PassThrough(), logs = new PassThrough();
  const originalInfo = LarkMateClient.prototype.chatInfo, originalHistory = LarkMateClient.prototype.history;
  LarkMateClient.prototype.chatInfo = async () => ({lastMessagePosition:1});
  LarkMateClient.prototype.history = async () => ({items:[],omittedPositions:0});
  let result='', socket;
  class MockSocket extends EventTarget {
    constructor() { super(); socket=this; this.readyState=1; queueMicrotask(()=>this.dispatchEvent(new Event('open'))); }
    send() {}
    close() { if(this.readyState===3)return; this.readyState=3; queueMicrotask(()=>this.dispatchEvent(new Event('close'))); }
    deliver(bytes) { const event=new Event('message'); event.data=bytes; this.dispatchEvent(event); }
  }
  logs.on('data',() => {
    socket.deliver(push(g,'999','8','private'));
    socket.deliver(push(g,'123','5','hello'));
    socket.deliver(push(g,'123','5','hello'));
    socket.deliver(g.encode('Frame',{payload:g.encode('Packet',{cmd:6000,payloadType:1})}));
  });
  output.on('data', chunk => { result+=chunk; if(result.includes('missing_push_identifiers')) controller.abort(); });
  try { await listen({gateway:g,chatIds:['123'],output,log:logs,signal:controller.signal,WebSocketImpl:MockSocket}); }
  finally { LarkMateClient.prototype.chatInfo=originalInfo; LarkMateClient.prototype.history=originalHistory; }
  const items=result.trim().split('\n').map(JSON.parse);
  assert.deepEqual(items.filter(x=>x.kind==='message').map(x=>x.text),['hello']);
  assert.equal(items.some(x=>x.text==='private'),false);
  assert.equal(items.some(x=>x.reason==='missing_push_identifiers'),true);
});

test('reconnect reports a gap and backfills messages after the last position', async () => {
  const g = await gateway(), controller = new AbortController(), output = new PassThrough(), logs = new PassThrough();
  const originalInfo = LarkMateClient.prototype.chatInfo, originalHistory = LarkMateClient.prototype.history;
  let reads=0, connections=0, socket, result='';
  LarkMateClient.prototype.chatInfo = async () => ({lastMessagePosition:++reads<=2?1:3});
  LarkMateClient.prototype.history = async ({start,limit}) => { assert.equal(start,3); assert.equal(limit,1); return {items:[{id:'6',senderId:'7',type:4,text:'backfill',position:3}],omittedPositions:0}; };
  class MockSocket extends EventTarget {
    constructor(){super();socket=this;this.readyState=1;queueMicrotask(()=>this.dispatchEvent(new Event('open')))}
    send(){} close(){if(this.readyState===3)return;this.readyState=3;queueMicrotask(()=>this.dispatchEvent(new Event('close')))}
    deliver(bytes){let e=new Event('message');e.data=bytes;this.dispatchEvent(e)}
  }
  logs.on('data',()=>{if(++connections===1){socket.deliver(push(g,'123','5','live'));setTimeout(()=>socket.close(),10)}});
  output.on('data',chunk=>{result+=chunk;if(result.includes('backfill'))controller.abort()});
  try{await listen({gateway:g,chatIds:['123'],output,log:logs,signal:controller.signal,WebSocketImpl:MockSocket})}
  finally{LarkMateClient.prototype.chatInfo=originalInfo;LarkMateClient.prototype.history=originalHistory}
  const events=result.trim().split('\n').map(JSON.parse);
  assert.equal(events.some(x=>x.kind==='gap'&&x.reason==='connection_interrupted'),true);
  assert.equal(events.some(x=>x.text==='backfill'&&x.backfill===true),true);
});

test('listener resolves compacted message pushes before delivering them', async () => {
  const g=await gateway(), controller=new AbortController(), output=new PassThrough(), logs=new PassThrough();let socket,result='';
  const originalInfo=LarkMateClient.prototype.chatInfo,originalHistory=LarkMateClient.prototype.history;
  LarkMateClient.prototype.chatInfo=async()=>({lastMessagePosition:1});LarkMateClient.prototype.history=async()=>({items:[],omittedPositions:0});
  const inner=g.decode('Packet',g.decode('Frame',push(g,'123','5','from packet')).payload);
  g.call=async(cmd,_type,body)=>{assert.equal(cmd,12001);assert.deepEqual(body.sids,['44']);return {packet:{payload:g.encode('PullPacketsBySidsResponse',{packets:{'44':inner}})}}};
  class MockSocket extends EventTarget{constructor(){super();socket=this;this.readyState=1;queueMicrotask(()=>this.dispatchEvent(new Event('open')))}send(){}close(){if(this.readyState===3)return;this.readyState=3;queueMicrotask(()=>this.dispatchEvent(new Event('close')))}deliver(bytes){let e=new Event('message');e.data=bytes;this.dispatchEvent(e)}}
  logs.on('data',()=>socket.deliver(g.encode('Frame',{payload:g.encode('Packet',{cmd:6000,sid:'44'})})));
  output.on('data',chunk=>{result+=chunk;if(result.includes('from packet'))controller.abort()});
  try{await listen({gateway:g,chatIds:['123'],output,log:logs,signal:controller.signal,WebSocketImpl:MockSocket})}finally{LarkMateClient.prototype.chatInfo=originalInfo;LarkMateClient.prototype.history=originalHistory}
  assert.equal(JSON.parse(result.trim()).text,'from packet');
});

test('global listener accepts multiple chats and reports unknown coverage while backfilling known chats', async () => {
  const g=await gateway(), controller=new AbortController(), output=new PassThrough(), logs=new PassThrough();
  const originalInfo=LarkMateClient.prototype.chatInfo,originalHistory=LarkMateClient.prototype.history;
  let socket,connections=0,result='';
  LarkMateClient.prototype.chatInfo=async()=>({lastMessagePosition:3});
  LarkMateClient.prototype.history=async({chatId,start})=>({items:[{id:chatId==='123'?'31':'32',senderId:'7',type:4,text:'recovered',position:start}],omittedPositions:0});
  class MockSocket extends EventTarget{constructor(){super();socket=this;this.readyState=1;queueMicrotask(()=>this.dispatchEvent(new Event('open')))}send(){}close(){if(this.readyState===3)return;this.readyState=3;queueMicrotask(()=>this.dispatchEvent(new Event('close')))}deliver(bytes){let e=new Event('message');e.data=bytes;this.dispatchEvent(e)}}
  logs.on('data',()=>{if(++connections===1){socket.deliver(push(g,'123','11','first'));socket.deliver(push(g,'456','12','second'));setTimeout(()=>socket.close(),10)}});
  output.on('data',chunk=>{result+=chunk;const matches=result.match(/"backfill":true/g)||[];if(matches.length===2)controller.abort()});
  try{await listen({gateway:g,output,log:logs,signal:controller.signal,WebSocketImpl:MockSocket})}
  finally{LarkMateClient.prototype.chatInfo=originalInfo;LarkMateClient.prototype.history=originalHistory}
  const events=result.trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.filter(x=>x.kind==='message'&&!x.backfill).map(x=>x.chatId),['123','456']);
  assert.equal(events.some(x=>x.reason==='global_coverage_unknown'),true);
  assert.deepEqual(events.filter(x=>x.backfill).map(x=>x.chatId),['123','456']);
});

test('global backfill continues when one previously seen chat is unavailable', async () => {
  const g=await gateway(),controller=new AbortController(),output=new PassThrough(),logs=new PassThrough();
  const originalInfo=LarkMateClient.prototype.chatInfo,originalHistory=LarkMateClient.prototype.history;
  let socket,connections=0,result='';
  LarkMateClient.prototype.chatInfo=async()=>({lastMessagePosition:3});
  LarkMateClient.prototype.history=async({chatId,start})=>{if(chatId==='123')throw new Error('unavailable');return {items:[{id:'42',senderId:'7',type:4,text:'other recovered',position:start}],omittedPositions:0}};
  class MockSocket extends EventTarget{constructor(){super();socket=this;this.readyState=1;queueMicrotask(()=>this.dispatchEvent(new Event('open')))}send(){}close(){if(this.readyState===3)return;this.readyState=3;queueMicrotask(()=>this.dispatchEvent(new Event('close')))}deliver(bytes){let e=new Event('message');e.data=bytes;this.dispatchEvent(e)}}
  logs.on('data',()=>{if(++connections===1){socket.deliver(push(g,'123','11','first'));socket.deliver(push(g,'456','12','second'));setTimeout(()=>socket.close(),10)}});
  output.on('data',chunk=>{result+=chunk;if(result.includes('other recovered'))controller.abort()});
  try{await listen({gateway:g,output,log:logs,signal:controller.signal,WebSocketImpl:MockSocket})}
  finally{LarkMateClient.prototype.chatInfo=originalInfo;LarkMateClient.prototype.history=originalHistory}
  const events=result.trim().split('\n').map(JSON.parse);
  assert.equal(events.some(x=>x.chatId==='123'&&x.reason==='backfill_failed'),true);
  assert.equal(events.some(x=>x.chatId==='456'&&x.text==='other recovered'),true);
});
