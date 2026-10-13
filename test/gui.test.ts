import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGuiMessage } from '../src/gui-server.ts';
test('GUI rejects empty, oversized and unknown bot messages', () => {
 assert.throws(() => validateGuiMessage({to:'a',text:' '}, ['a']));
 assert.throws(() => validateGuiMessage({to:'b',text:'hello'}, ['a']));
 assert.throws(() => validateGuiMessage({to:'a',text:'x'.repeat(20001)}, ['a']));
 assert.deepEqual(validateGuiMessage({to:'a',text:' hello '}, ['a']), {to:'a',text:'hello'});
});
import { startGui } from '../src/gui-server.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
test('GUI persists routed messages and rejects untrusted writes', async()=>{
 const dir=await mkdtemp(resolve('work/gui/test-'));process.env.PI_BOT_DIR=dir;process.env.PI_BOT_GUI_PORT='0';
 const host=await startGui({factory:async (_bot,host)=>({async run(e){host.sendMessage(e,'test result','reply:'+e.id)},async close(){}})});
 try{
  const url=`http://127.0.0.1:${(host.server.address() as {port:number}).port}`;
  let state=await (await fetch(url+'/api/state')).json() as any;
  const to=state.bots[0].id;
  assert.equal((await fetch(url+'/api/message',{method:'POST',body:JSON.stringify({to,text:'test'})})).status,403);
  const response=await fetch(url+'/api/message',{method:'POST',headers:{'Content-Type':'application/json','X-Gui-Token':state.token},body:JSON.stringify({to,text:'hello'})});
  assert.equal(response.status,200);await host.runtime.idle();await host.runtime.deliver(async()=>{});
  state=await (await fetch(url+'/api/state')).json() as any;
  assert.equal(state.messages.length,2);assert.equal(state.messages[0].botId,to);assert.equal(state.messages[1].status,'delivered');
  const groupBot=host.runtime.createBot('group-bot','','group-a');
  const routed=await fetch(url+'/api/message',{method:'POST',headers:{'Content-Type':'application/json','X-Gui-Token':state.token},body:JSON.stringify({to:groupBot.id,text:'group task',key:'group-task'})});
  assert.equal(routed.status,200);const routedEnvelope=await routed.json() as any;assert.equal(routedEnvelope.route.channelId,'group-a');
  await host.runtime.idle();await host.runtime.deliver(async()=>{});
  const routedAgain=await fetch(url+'/api/message',{method:'POST',headers:{'Content-Type':'application/json','X-Gui-Token':state.token},body:JSON.stringify({to:groupBot.id,text:'group task',key:'group-task'})});
  assert.equal((await routedAgain.json() as any).id,routedEnvelope.id);
  const post=async(path:string,body:unknown)=>fetch(url+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Gui-Token':state.token},body:JSON.stringify(body)});
  const created=await post('routine/create',{botId:to,kind:'schedule',prompt:'future task',at:Date.now()+60000,timezone:'Asia/Shanghai'});
  assert.equal(created.status,200);const routine=await created.json() as any;
  assert.equal((await post('routine/action',{botId:to,kind:'schedule',id:routine.id,action:'pause'})).status,200);
  assert.equal(host.proactive.listSchedules(to)[0].state,'paused');
  assert.equal((await post('routine/action',{botId:to,kind:'schedule',id:routine.id,action:'resume'})).status,200);
  assert.equal(host.proactive.listSchedules(to)[0].state,'active');
  assert.equal((await post('routine/action',{botId:'other',kind:'schedule',id:routine.id,action:'cancel'})).status,400);
  assert.equal((await post('routine/create',{botId:to,kind:'schedule',prompt:'bad',at:0})).status,400);
  const mon=await post('routine/create',{botId:to,kind:'monitor',prompt:'report file changes',detector:'file',intervalMs:1000,deadline:Date.now()+60000});
  assert.equal(mon.status,200);const monitor=await mon.json() as any;
  assert.equal((await post('routine/action',{botId:to,kind:'monitor',id:monitor.id,action:'enable'})).status,400);
  assert.equal((await post('routine/action',{botId:to,kind:'monitor',id:monitor.id,action:'dry-run'})).status,200);
  assert.equal((await post('routine/action',{botId:to,kind:'monitor',id:monitor.id,action:'enable'})).status,200);
  assert.equal((await post('routine/action',{botId:to,kind:'monitor',id:monitor.id,action:'pause'})).status,200);
  assert.equal(host.proactive.listMonitors(to)[0].enabled,false);
  assert.equal((await post('routine/action',{botId:to,kind:'monitor',id:monitor.id,action:'cancel'})).status,200);
 }finally{await host.close();delete process.env.PI_BOT_DIR;delete process.env.PI_BOT_GUI_PORT;await rm(dir,{recursive:true,force:true});}
});
