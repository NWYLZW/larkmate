import http from 'node:http';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, lstat, realpath, chmod, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { FeishuError, requireInt64Id } from './errors.js';

const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const only = (x, fields) => obj(x) && Object.keys(x).every(k => fields.includes(k));
const invalid = message => { throw new FeishuError('LISTEN_CONFIG_INVALID', message); };
function stringArray(value, label, max = 100) {
  if (!Array.isArray(value) || value.length > max || value.some(x => typeof x !== 'string' || Buffer.byteLength(x)>4096)) invalid(`Invalid ${label}.`);
  return value;
}
function script(value, label) {
  if (!only(value,['path','args','timeoutSeconds']) || typeof value.path !== 'string' || !isAbsolute(value.path) || value.path.includes('\0')) invalid(`Invalid ${label}.`);
  const args = value.args === undefined ? [] : stringArray(value.args, `${label} arguments`, 32);
  const timeoutSeconds = value.timeoutSeconds ?? 30;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) invalid(`Invalid ${label} timeout.`);
  return {path:value.path,args,timeoutSeconds};
}
export function parseListenRules(raw) {
  if (!only(raw,['version','rules']) || raw.version!==1 || !Array.isArray(raw.rules) || !raw.rules.length || raw.rules.length>100) invalid('Use version 1 and 1 to 100 rules.');
  const names=new Set(), chats=new Set();
  const rules=raw.rules.map(r=>{
    if (!only(r,['name','chatIds','senderIds','types','contains','excludeContains','excludeSelf','filter','run']) || typeof r.name!=='string' || !r.name.trim() || r.name.length>100 || names.has(r.name)) invalid('Invalid or duplicate rule name.');
    names.add(r.name);
    const chatIds=stringArray(r.chatIds,'chat IDs'); if (!chatIds.length) invalid('Every rule needs at least one chat ID.');
    for(const id of chatIds){requireInt64Id(id,'chat ID');chats.add(id);}
    const senderIds=r.senderIds===undefined?null:stringArray(r.senderIds,'sender IDs'); if(senderIds)for(const id of senderIds)requireInt64Id(id,'sender ID');
    const types=r.types===undefined?null:r.types;
    if(types!==null&&(!Array.isArray(types)||types.length>100||types.some(x=>!Number.isInteger(x)||x<0)))invalid('Invalid message types.');
    for(const k of ['contains','excludeContains'])if(r[k]!==undefined&&(typeof r[k]!=='string'||!r[k]||Buffer.byteLength(r[k])>4096))invalid(`Invalid ${k}.`);
    if(r.excludeSelf!==undefined&&typeof r.excludeSelf!=='boolean')invalid('Invalid excludeSelf.');
    return {name:r.name,chatIds,senderIds,types,contains:r.contains,excludeContains:r.excludeContains,excludeSelf:r.excludeSelf===true,filter:r.filter===undefined?null:script(r.filter,'filter'),run:script(r.run,'run')};
  });
  if(chats.size>100)invalid('At most 100 distinct chats are allowed.');
  return {rules,chatIds:[...chats]};
}
export async function loadListenRules(path) {
  let f;
  try { f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW); const st=await f.stat();
    if(!st.isFile()||st.size>65536||![0,process.getuid?.()].includes(st.uid)||(st.mode&0o022)) throw new Error();
    const input=await f.readFile('utf8');return parseListenRules(JSON.parse(input));
  } catch(e) { if(e instanceof FeishuError)throw e;throw new FeishuError('LISTEN_CONFIG_INVALID','Cannot read a protected rules file.'); }
  finally { await f?.close(); }
}
function matches(rule,event,selfId) {
  return event.kind==='message'&&rule.chatIds.includes(event.chatId)&&(!rule.senderIds||rule.senderIds.includes(event.senderId))&&(!rule.types||rule.types.includes(event.type))
    &&(!rule.excludeSelf||(selfId&&event.senderId!==selfId))&&(rule.contains===undefined||(event.text||'').includes(rule.contains))&&(rule.excludeContains===undefined||!(event.text||'').includes(rule.excludeContains));
}
function runScript(config,event) {
  return new Promise(resolve=>{
    let child, settled=false, timer;
    const done=(result)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result)};
    try { child=spawn(config.path,config.args,{shell:false,stdio:['pipe','ignore','ignore'],env:{PATH:process.env.PATH||'/usr/bin:/bin',HOME:process.env.HOME||'',LANG:process.env.LANG||'C.UTF-8'}}); }
    catch {return done({ok:false,reason:'spawn_failed'});}
    timer=setTimeout(()=>{child.kill('SIGKILL');done({ok:false,reason:'timeout'})},config.timeoutSeconds*1000);
    child.on('error',()=>done({ok:false,reason:'spawn_failed'}));
    child.on('close',code=>done({ok:code===0,code}));
    child.stdin.on('error',()=>{});child.stdin.end(`${JSON.stringify(event)}\n`);
  });
}
export function createRuleOutput({rules,selfId,log=process.stderr}) {
  return new Writable({write(chunk,_encoding,callback){(async()=>{
    const event=JSON.parse(chunk.toString());
    if(event.kind!=='message'){log.write(`${JSON.stringify(event)}\n`);return;}
    for(const rule of rules){if(!matches(rule,event,selfId))continue;
      if(rule.filter){const result=await runScript(rule.filter,event);if(!result.ok){if(result.code!==1)log.write(`${JSON.stringify({kind:'filter_error',rule:rule.name,reason:result.reason||'exit',code:result.code})}\n`);continue;}}
      const result=await runScript(rule.run,event);if(!result.ok)log.write(`${JSON.stringify({kind:'script_error',rule:rule.name,reason:result.reason||'exit',code:result.code})}\n`);
    }
  })().then(()=>callback(),callback)}});
}

// Exposes only the preselected chat stream, protected by the socket and parent directory permissions.
export async function startListenService(socketPath) {
  if(typeof socketPath!=='string'||!isAbsolute(socketPath)||socketPath.endsWith('/'))throw new FeishuError('INVALID_ARGUMENT','Use an absolute socket path.');
  let parent;try{parent=await realpath(dirname(socketPath));}catch{throw new FeishuError('LISTEN_SOCKET_INVALID','The socket directory must exist.');}
  const st=await lstat(parent);if(!st.isDirectory()||st.uid!==process.getuid?.()||(st.mode&0o022))throw new FeishuError('LISTEN_SOCKET_INVALID','The socket directory must be owned by the user and not writable by others.');
  const path=join(parent,socketPath.slice(socketPath.lastIndexOf('/')+1));
  try{await lstat(path);throw new FeishuError('LISTEN_SOCKET_EXISTS','The socket path already exists.');}catch(e){if(e.code!=='ENOENT')throw e;}
  const clients=new Set();
  const server=http.createServer((req,res)=>{
    if(req.method!=='GET'||req.url!=='/events'){res.writeHead(404);res.end();return;}
    if(clients.size>=20){res.writeHead(503);res.end();return;}
    res.writeHead(200,{'content-type':'application/x-ndjson','cache-control':'no-store','x-content-type-options':'nosniff'});res.flushHeaders();clients.add(res);res.on('close',()=>clients.delete(res));
  });
  const oldMask=process.umask(0o077);
  try { await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve)}); } finally { process.umask(oldMask); }
  await chmod(path,0o600);const inode=(await lstat(path)).ino;
  const output=new Writable({write(chunk,_encoding,callback){for(const client of clients){if(client.writableLength>1024*1024){client.destroy();continue;}client.write(chunk);}callback();}});
  return {path,output,async close(){for(const c of clients)c.destroy();await new Promise(resolve=>server.close(resolve));try{const now=await lstat(path);if(now.ino===inode&&now.isSocket())await unlink(path);}catch(e){if(e.code!=='ENOENT')throw e;}}};
}
