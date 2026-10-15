// Explicit disposable test runtime. Never reads the user's Pi profile or generates access grants.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PiBotDaemon } from '../../../src/daemon/core/daemon.ts';
const root=resolve(process.argv[2]);
const token='a'.repeat(64); // Dummy fixture transport value only.
mkdirSync(root,{recursive:true});
const daemon=await PiBotDaemon.create({dataDir:root,piOptions:{agentDir:join(root,'empty-pi'),cwd:root},factory:async (bot,host)=>({
  run:async envelope=>{
    if(process.argv.includes('--message-layout') && envelope.text === 'Stream layout fixture') {
      host.sendMessage(envelope,'A completed fixture bubble before streaming.','layout-first:'+envelope.id);
      host.sendMessage(envelope,'Another consecutive fixture bubble from the same sender.','layout-second:'+envelope.id);
      const toolCallId='layout-stream:'+envelope.id;
      let answer='';
      for(const piece of ['This ', 'is ', 'a ', 'controlled ', 'group ', 'stream ', 'with ', 'stable ', 'sender ', 'attribution.']) {
        answer+=piece; host.events?.emit(bot.id,{type:'replyDelta',toolCallId,textDelta:piece});
        await new Promise(r=>setTimeout(r,450));
      }
      host.sendMessage(envelope,answer,'layout-final:'+envelope.id,toolCallId); return;
    }
    if(process.argv.includes('--visual')) {
      host.sendMessage(envelope,'这是隔离的界面排版测试。内容用于检查行距、气泡宽度和换行，不会执行任何外部操作。\n\n'+envelope.text,'fixture:'+envelope.id);
      host.sendMessage(envelope,'测试记录已保留，下一条消息仍可独立处理。','fixture-extra:'+envelope.id);
      return;
    }
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
if(process.argv.includes('--visual')) {
  const bot=daemon.runtime.listBots()[6] || daemon.runtime.listBots()[0];
  for(const [i,text] of ['请比较两种界面排版方式，保留相同的测试数据。','只需要检查消息与状态，不进行外部操作。','排版完成后保留对比图片。'].entries()) daemon.runtime.accept({to:bot.id,text,key:'visual-seed:'+i});
  await daemon.runtime.idle();
}
if (process.argv.includes('--bubble-colors')) {
  for (const [name,color] of [['Custom Dark Fixture','#173252'],['Custom Light Fixture','#f2e8bf']]) {
    const bot=daemon.runtime.listBots().find(b=>b.name===name) || daemon.runtime.createBot(name,'Disposable bubble contrast fixture');
    daemon.runtime.store.put('bots',{...bot,avatar:{shape:1,color}});
    daemon.runtime.accept({to:bot.id,text:'Custom identity color contrast test. No external operations.',key:'palette-seed:'+bot.id});
  }
  const members=daemon.runtime.listBots().slice(0,2).map(b=>b.id);
  const group=daemon.runtime.listGroups().find(g=>g.name==='Fixture Palette Group') || daemon.runtime.createGroup('Fixture Palette Group',members);
  daemon.runtime.acceptGroupUser(group.id,'Group bubbles use neutral light gray, independent of member colors.','palette-group-seed');
  await daemon.runtime.idle();
}
if(process.argv.includes('--message-layout')) {
  const bots=daemon.runtime.listBots();
  const a=bots.find(b=>b.name==='Fixture Bot 7') || bots[0];
  const b=bots.find(b=>b.name==='Custom Dark Fixture') || bots[1];
  const group=daemon.runtime.listGroups().find(g=>g.name==='Fixture Message Layout') || daemon.runtime.createGroup('Fixture Message Layout',[a.id,b.id]);
  const template=daemon.runtime.store.list<any>('group_messages').find(m=>m.sourceKind==='bot');
  if(!template) throw Error('Message layout fixture requires --bubble-colors');
  const base=Date.parse('2026-10-14T15:58:00Z');
  const rows=[
    ['user',0,'Controlled sender-run and time-separator fixture.'],
    [a.id,1000,'First consecutive message from the teal sender.'],
    [a.id,2000,'Second message: one sender label and one bottom-aligned avatar for this run.'],
    [b.id,3000,'A different real sender with a custom dark identity color.'],
    ['deleted-fixture-member',4000,'Removed-member fixture: never borrow the selected bot identity.'],
    [a.id,120000,'Across midnight in Asia/Shanghai; keep the real date boundary.'],
    [a.id,600000,'A later message after a meaningful time gap.'],
  ] as const;
  rows.forEach(([sender,offset,text],i)=>{const id='message-layout-fixture-'+i;daemon.runtime.store.put('group_messages',{...template,id,messageId:id,groupMessageId:id,channelId:group.id,conversationId:group.id,recipient:'group',sender,botId:a.id,taskId:'layout-task-fixture',sourceKind:sender==='user'?'user':'bot',direction:'inbound',status:'received',text,receivedAt:base+offset});});
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
  if (existsSync(join(root,'ui-offline'))) { res.writeHead(503).end(); return; }
  if(url.pathname==='/events') {
    const c=daemon.connections.get(String(req.headers['x-pibot-connection']));
    if(!c) {res.writeHead(404).end();return;}
    res.writeHead(200,{'content-type':'text/event-stream'});res.write(': fixture\n\n');
    const detach=c.attach(frame=>res.write('data: '+JSON.stringify(frame)+'\n\n'));
    const outage = setInterval(() => { if (existsSync(join(root,'ui-offline'))) res.destroy(); }, 200);
    req.on('close',()=>{clearInterval(outage);detach();});return;
  }
  if(url.pathname==='/rpc') {
    let body='';for await(const chunk of req) body+=chunk;
    const frame=JSON.parse(body);
    let c=daemon.connections.get(String(req.headers['x-pibot-connection']));
    if(frame.method==='initialize') c=daemon.connect('http');
    if(!c) {res.writeHead(404).end();return;}
    if (frame.method === 'turn/start' && existsSync(join(root,'ui-fail-send'))) {
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({jsonrpc:'2.0',id:frame.id,error:{code:-32000,message:'Controlled fixture send failure',data:{reason:'capacity'}}})); return;
    }
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
