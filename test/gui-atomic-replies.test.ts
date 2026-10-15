import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, stateFromSnapshot } from '../src/sdk/state/reducer.ts';
import { completedMessages, botActivity } from '../src/gui/presentation.ts';
const snapshot = (turns: any[] = [], items: any[] = []) => ({seq:0,status:'ready',bots:[],groups:[],threads:[],turns,items,requests:[],routines:[],jobs:[]}) as any;
const turn = (id: string, botId: string, status = 'running') => ({id,botId,threadId:'thread:'+botId,status});
const item = (id: string, botId: string, text: string) => ({id,type:'agentMessage',status:'completed',toolCallId:'tool:'+id,message:{messageId:id,botId,sender:botId,direction:'outbound',status:'delivered',receivedAt:1,text}});
const event = (method: string, params: any, seq: number | null = null) => ({method,params,seq}) as any;
const view = (s: any) => ({messages:completedMessages(Object.values(s.items)), turns:Object.values(s.turns),jobs:Object.values(s.jobs),requests:Object.values(s.requests)});
test('shared desktop/iOS presentation hides all deltas and publishes each complete sender message once', () => {
 let s = stateFromSnapshot(snapshot([turn('a','alice'),turn('b','bob')],[item('old','alice','earlier complete')]));
 for (const bot of ['alice','bob']) s=applyEvent(s,event('item/agentMessage/delta',{toolCallId:'tool:'+bot,turnId:bot==='alice'?'a':'b',threadId:'thread:'+bot,textDelta:'PRIVATE PARTIAL '+bot}));
 assert.deepEqual(view(s).messages.map(m=>m.text),['earlier complete']);
 assert.equal(botActivity(view(s),'alice'),'working'); assert.equal(botActivity(view(s),'bob'),'working'); assert.equal(botActivity(view(s),'unrelated'),'idle');
 s=applyEvent(s,event('item/completed',{item:item('alice','alice','complete alice')},1));
 s=applyEvent(s,event('item/completed',{item:item('alice','alice','complete alice')},1));
 assert.deepEqual(view(s).messages.map(m=>m.text),['earlier complete','complete alice']);
 s=applyEvent(s,event('item/completed',{item:item('bob','bob','complete bob')},2));
 assert.equal(view(s).messages.length,3);
 const reconciled=stateFromSnapshot(snapshot(Object.values(s.turns),Object.values(s.items)));
 assert.deepEqual(view(reconciled).messages,view(s).messages);
 assert.deepEqual(reconciled.streaming,{});
});
test('completion, failure and cancellation stop only the corresponding bot and never publish buffered drafts', () => {
 for (const status of ['completed','failed','cancelled','interrupted']) {
  let s=stateFromSnapshot(snapshot([turn('a','alice'),turn('b','bob')],[item('old','alice','keep')]));
  s=applyEvent(s,event('item/agentMessage/delta',{toolCallId:'partial',turnId:'a',threadId:'thread:alice',textDelta:'never show'}));
  s=applyEvent(s,event('turn/completed',{turn:turn('a','alice',status)},1));
  assert.equal(botActivity(view(s),'alice'),'idle',status); assert.equal(botActivity(view(s),'bob'),'working');
  assert.deepEqual(view(s).messages.map(m=>m.text),['keep']); assert.deepEqual(s.streaming,{});
 }
});
test('pending user decisions remain distinct from running; another task can still run', () => {
 const data:any={turns:[{...turn('a','alice'),taskId:'waiting'}],messages:[],requests:[{botId:'alice',status:'pending',params:{taskId:'waiting'}}]};
 assert.equal(botActivity(data,'alice'),'attention');
 data.turns.push({...turn('other','alice'),taskId:'independent'});
 assert.equal(botActivity(data,'alice'),'working'); assert.equal(botActivity(data,'bob'),'idle');
 const restored=stateFromSnapshot(snapshot([turn('a','alice')]));
 assert.equal(botActivity(view(restored),'alice'),'working');
});

test('a partial outbound item cannot replace delivered history', () => {
 const pending={...item('pending','alice','not delivered'),message:{...item('pending','alice','').message,status:'sending'}};
 assert.deepEqual(completedMessages([item('old','alice','kept'),pending]).map(m=>m.text),['kept']);
});
