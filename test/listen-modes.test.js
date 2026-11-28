import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {parseListenRules,createRuleOutput,startListenService} from '../src/listen-modes.js';

test('rules invoke fixed filter and action with the matching event on stdin', async t=>{
 const dir=await mkdtemp(join(tmpdir(),'larkmate-rules-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const filter=join(dir,'filter.cjs'), action=join(dir,'action.cjs'), result=join(dir,'result.json');
 await writeFile(filter,"let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>process.exit(JSON.parse(s).text.includes('go')?0:1));");
 await writeFile(action,"let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>require('fs').writeFileSync(process.argv[2],s));");
 const config=parseListenRules({version:1,rules:[{name:'r',chatIds:['123'],senderIds:['7'],contains:'go',filter:{path:process.execPath,args:[filter]},run:{path:process.execPath,args:[action,result]}}]});
 const sink=createRuleOutput(config);sink.write(JSON.stringify({kind:'message',chatId:'999',senderId:'7',text:'go'})+'\n');sink.write(JSON.stringify({kind:'message',chatId:'123',senderId:'7',text:'go safely'})+'\n');sink.end();await once(sink,'finish');
 assert.equal(JSON.parse(await readFile(result,'utf8')).text,'go safely');
 assert.throws(()=>parseListenRules({version:1,rules:[{name:'x',chatIds:[],run:{path:'/bin/true'}}]}),{code:'LISTEN_CONFIG_INVALID'});
});

test('local event service uses a private socket and cleans it up', async t=>{
 const dir=await mkdtemp(join(tmpdir(),'larkmate-events-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const socket=join(dir,'events.sock');const service=await startListenService(socket);
 try{assert.equal((await stat(socket)).mode&0o077,0);await assert.rejects(startListenService(socket),{code:'LISTEN_SOCKET_EXISTS'});const response=await new Promise((resolve,reject)=>{let r=http.get({socketPath:socket,path:'/events'},resolve);r.on('error',reject)});let received=once(response,'data');service.output.write('{"kind":"message"}\n');assert.equal((await received)[0].toString(),'{"kind":"message"}\n');response.destroy();}finally{await service.close()}
 await assert.rejects(stat(socket),{code:'ENOENT'});
});
