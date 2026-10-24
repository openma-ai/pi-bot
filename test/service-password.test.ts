import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket,WebSocketServer} from 'ws';
import {ServicePassword} from '../src/daemon/transports/service-password.ts';
import {createTailnetGateway} from '../src/daemon/transports/tailnet-gateway.ts';
test('service password: local init, safe hash, persistent/revocable/expiring sessions, binary/SSE/WS auth',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pibo-password-'));const secret='synthetic-password-only';
 const runtime=createServer((req,res)=>{if(req.url==='/readyz'){res.end();return;}assert.equal(req.headers.authorization,'Bearer '+'a'.repeat(64));if(req.url==='/events'){res.setHeader('content-type','text/event-stream');res.end('data: synthetic\n\n');}else req.pipe(res);});
 const wss=new WebSocketServer({server:runtime});wss.on('connection',c=>c.on('message',(b,binary)=>c.send(b,{binary})));
 await new Promise<void>(r=>runtime.listen(0,'127.0.0.1',r));
 const options={host:'100.100.1.2',port:4319,dataDir:dir,runtime:{url:`http://127.0.0.1:${(runtime.address() as any).port}`,token:'a'.repeat(64)}};
 let g=createTailnetGateway(options);let port=0;
 const start=async()=>{await new Promise<void>(r=>g.server.listen(0,'127.0.0.1',r));port=(g.server.address() as any).port;};await start();
 const call=(path:string,body?:any,token?:string,method=body?'POST':'GET')=>new Promise<{status:number,bytes:Buffer,json:any}>(resolve=>{const q=request({host:'127.0.0.1',port,path,method,headers:{host:'100.100.1.2:4319',...(token?{authorization:`Bearer ${token}`}:{})}},r=>{const b:Buffer[]=[];r.on('data',c=>b.push(c));r.on('end',()=>{const bytes=Buffer.concat(b);let json;try{json=JSON.parse(bytes.toString());}catch{}resolve({status:r.statusCode!,bytes,json});});});q.end(Buffer.isBuffer(body)?body:body?JSON.stringify(body):undefined);});
 try{
  assert.equal((await call('/pibo/login',{password:secret})).status,401);
  assert.equal((await call('/pibo/setup',{password:secret})).status,401);
  assert.equal((await call('/rpc')).status,401);
  await g.setPassword(secret);
  const stored=readFileSync(join(dir,'service-password.json'),'utf8');assert.ok(!stored.includes(secret));assert.equal(statSync(join(dir,'service-password.json')).mode&0o777,0o600);
  assert.equal((await call('/pibo/login',Buffer.from('null'))).status,401);
  assert.equal((await call('/pibo/login',{password:'wrong'})).status,401);
  const login=await call('/pibo/login',{password:secret});assert.equal(login.status,200);let token=login.json.token;assert.ok(!readFileSync(join(dir,'tailnet-devices.json'),'utf8').includes(token));
  assert.equal((await call('/pibo/ready',undefined,token)).status,200);
  const bytes=Buffer.from([0,255,128,1,0]);assert.deepEqual((await call('/api/files',bytes,token)).bytes,bytes);assert.match((await call('/events',undefined,token)).bytes.toString(),/synthetic/);
  const ws=new WebSocket(`ws://127.0.0.1:${port}/api/desktop/synthetic/ws`,{headers:{host:'100.100.1.2:4319',authorization:'Bearer '+token}});await new Promise<void>((r,n)=>{ws.once('open',r);ws.once('error',n);});ws.send(bytes);assert.deepEqual(await new Promise<Buffer>(r=>ws.once('message',b=>r(Buffer.from(b as Buffer)))),bytes);
  const closed=new Promise<void>(r=>ws.once('close',()=>r()));g.revoke(login.json.deviceId);await closed;assert.equal((await call('/rpc',undefined,token)).status,401);
  token=(await call('/pibo/login',{password:secret})).json.token;await g.close();g=createTailnetGateway(options);await start();assert.equal((await call('/pibo/ready',undefined,token)).status,200);
  await g.setPassword(secret+'-rotated');assert.equal((await call('/pibo/ready',undefined,token)).status,401);
  const logout=await call('/pibo/login',{password:secret+'-rotated'});
  await call('/api/files',Buffer.from('synthetic'),logout.json.token);
  assert.equal((await call('/pibo/logout',{},logout.json.token)).status,200);
  assert.equal((await call('/pibo/ready',undefined,logout.json.token)).status,401);
  const next=await call('/pibo/login',{password:secret+'-rotated'});token=next.json.token;
  await g.close();const file=join(dir,'tailnet-devices.json');const devices=JSON.parse(readFileSync(file,'utf8'));devices[next.json.deviceId].expiresAt=Date.now()-1;writeFileSync(file,JSON.stringify(devices));g=createTailnetGateway(options);await start();assert.equal((await call('/pibo/ready',undefined,token)).status,401);
  for(let i=0;i<10;i++)await call('/pibo/login',{password:'wrong'});assert.equal((await call('/pibo/login',{password:secret+'-rotated'})).status,429);
 }finally{await g.close();wss.close();await new Promise<void>(r=>runtime.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});
test('password initializer validates length and corrupt store fails closed',async()=>{const dir=mkdtempSync(join(tmpdir(),'pibo-password-unit-'));try{const p=new ServicePassword(dir);await assert.rejects(p.set('short'));writeFileSync(join(dir,'service-password.json'),'{}');assert.throws(()=>new ServicePassword(dir));}finally{rmSync(dir,{recursive:true,force:true});}});
test('explicit HTTPS proxy authority and Tailnet authority share the same protected gateway',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pibo-origin-'));
 const base={host:'100.100.1.2',port:4319,dataDir:dir,runtime:{url:'http://127.0.0.1:4318',token:'a'.repeat(64)}};
 assert.throws(()=>createTailnetGateway({...base,serviceOrigin:'https://pibo.example.invalid'}));
 assert.throws(()=>createTailnetGateway({...base,listenMode:'serve-loopback',serviceOrigin:'http://pibo.example.invalid'}));
 const g=createTailnetGateway({...base,listenMode:'serve-loopback',serviceOrigin:'https://pibo.example.invalid'});
 await new Promise<void>(r=>g.server.listen(0,'127.0.0.1',r));
 const call=(host:string,origin?:string)=>new Promise<number>(resolve=>{request({host:'127.0.0.1',port:(g.server.address() as any).port,path:'/pibo/service',headers:{host,...(origin?{origin}:{})}},r=>{r.resume();resolve(r.statusCode!);}).end();});
 try{assert.equal(await call('pibo.example.invalid'),200);assert.equal(await call('100.100.1.2:4319'),200);assert.equal(await call('evil.invalid'),403);assert.equal(await call('pibo.example.invalid','https://evil.invalid'),403);}finally{await g.close();rmSync(dir,{recursive:true,force:true});}
});
