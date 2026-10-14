// Explicit disposable test runtime. Never reads the user's Pi profile or generates access grants.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PiBotDaemon } from '../../../src/daemon/core/daemon.ts';
const root=resolve(process.argv[2]);
const token='a'.repeat(64); // Dummy fixture transport value only.
mkdirSync(root,{recursive:true});
const daemon=await PiBotDaemon.create({dataDir:root,piOptions:{agentDir:join(root,'empty-pi'),cwd:root},factory:async (bot,host)=>({
  run:async envelope=>{
    const answer='Fixture reply: '+envelope.text;
    for (const piece of ['Fixture ', 'reply: ', envelope.text]) {
      host.events?.emit(bot.id,{type:'replyDelta',toolCallId:'fixture-'+envelope.id,textDelta:piece});
      await new Promise(r=>setTimeout(r,180));
    }
    host.sendMessage(envelope,answer,'fixture:'+envelope.id,'fixture-'+envelope.id);
  },close:async()=>{}
})});
daemon.piSettings=undefined;
if (!daemon.runtime.listBots().length) daemon.runtime.createBot('Fixture Bot','Disposable deterministic client test');
if (process.argv.includes('--navigation') && daemon.runtime.listBots().length === 1) {
  for (let i=1;i<=7;i++) daemon.runtime.createBot(`Fixture Bot ${i+1}`,'Disposable navigation fixture');
}
if (process.argv.includes('--navigation')) {
  for (const bot of daemon.runtime.listBots()) daemon.runtime.accept({to:bot.id,text:'Navigation fixture history for '+bot.name,key:'navigation-seed:'+bot.id});
  await daemon.runtime.idle();
}
const mockRequests:any[]=process.argv.includes('--requests') ? ['question','approval','credential'].map(kind=>({
  id:'fixture-request-'+kind,kind,botId:daemon.runtime.listBots()[0].id,threadId:'fixture-request-thread',turnId:null,status:'pending',createdAt:Date.now(),expiresAt:null,
  params:kind==='question'?{text:'Fixture question: choose an answer',questionId:'fixture-question',choices:['Fixture A','Fixture B']}:kind==='approval'?{tool:'fixture_no_execution',args:{operation:'inert fixture action'}}:{label:'Dummy fixture credential',formUrl:'/credential/fixture-form'},
})) : [];
function resolveMock(row:any,response:any) {
  row.status='resolved'; row.response=response;
  daemon.log.append('request/resolved',{request:row});
  return {request:row};
}
const server=createServer(async(req,res)=>{
  const expected='127.0.0.1:'+(server.address() as any).port;
  if(req.headers.host!==expected) {res.writeHead(403).end();return;}
  const url=new URL(req.url!,'http://localhost');
  if(url.pathname==='/readyz') {res.end('ready');return;}
  if(req.headers.authorization!=='Bearer '+token) {res.writeHead(401).end();return;}
  if(url.pathname==='/credential/fixture-form') {
    const row=mockRequests.find(r=>r.kind==='credential'&&r.status==='pending');
    if(!row) {res.writeHead(404).end();return;}
    if(req.method==='GET') {res.end('<!doctype html><title>Dummy fixture form</title>');return;}
    let body='';for await(const chunk of req) body+=chunk;
    if(typeof JSON.parse(body).secret!=='string') {res.writeHead(400).end();return;}
    resolveMock(row,{submitted:true}); // Never log or persist the dummy submitted value.
    res.setHeader('content-type','application/json');res.end('{"submitted":true}');return;
  }
  if(url.pathname==='/events') {
    const c=daemon.connections.get(String(req.headers['x-pibot-connection']));
    if(!c) {res.writeHead(404).end();return;}
    res.writeHead(200,{'content-type':'text/event-stream'});res.write(': fixture\n\n');
    const detach=c.attach(frame=>res.write('data: '+JSON.stringify(frame)+'\n\n'));
    req.on('close',detach);return;
  }
  if(url.pathname==='/rpc') {
    let body='';for await(const chunk of req) body+=chunk;
    const frame=JSON.parse(body);
    let c=daemon.connections.get(String(req.headers['x-pibot-connection']));
    if(!c && frame.method==='initialize') c=daemon.connect('http');
    if(!c) {res.writeHead(404).end();return;}
    let reply;
    const row=mockRequests.find(r=>r.id===frame.params?.requestId);
    if(frame.method==='request/resolve'&&row&&row.kind!=='credential') reply={jsonrpc:'2.0',id:frame.id,result:resolveMock(row,frame.params.response)};
    else {
      reply=await c.request(frame);
      if(frame.method==='daemon/snapshot'&&reply?.result) {reply.result.requests=[...reply.result.requests,...mockRequests];reply.result.pendingRequests=reply.result.requests.filter((r:any)=>r.status==='pending');}
    }
    if(!reply) {res.writeHead(204).end();return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));return;
  }
  res.writeHead(404).end();
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
writeFileSync(join(root,'daemon.json'),JSON.stringify({protocolVersion:'2026-10-13',http:'http://127.0.0.1:'+(server.address() as any).port,pid:process.pid,tokenFile:join(root,'daemon.token')}));
writeFileSync(join(root,'daemon.token'),token,{mode:0o600});
console.log('Disposable fixture directory: '+root);
process.on('SIGTERM',async()=>{server.closeAllConnections();server.close();await daemon.close();});
process.on('SIGINT',async()=>{server.closeAllConnections();server.close();await daemon.close();});
