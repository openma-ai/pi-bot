import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The GUI helper is a JavaScript module without a declaration file.
import { focusConversationRequest, requestCardId, requestsForConversation } from '../src/gui/conversation-requests.js';
import { isComposerSubmit } from '../src/gui/composer-keyboard.ts';
import { messageSegments } from '../src/gui/presentation.ts';

test('pending request survives completed source turn and remains scoped to its conversation', () => {
 const data = {groups:[{id:'group'}],threads:[{id:'direct',scope:{channelId:null}},{id:'group-thread',scope:{channelId:'group'}}],requests:[
  {id:'pending',kind:'approval',status:'pending',botId:'bot',threadId:'direct'},
  {id:'resolved',kind:'approval',status:'resolved',botId:'bot',threadId:'direct'},
  {id:'other',kind:'approval',status:'pending',botId:'other',threadId:'direct'},
  {id:'group-pending',kind:'question',status:'pending',botId:'bot',threadId:'group-thread'},
  {id:'cancelled',kind:'approval',status:'cancelled',botId:'bot',threadId:'direct'},
 ],turns:[{threadId:'direct',status:'completed'}]};
 assert.deepEqual(requestsForConversation(data,'bot','bot').map((r:{id:string})=>r.id),['pending']);
 assert.deepEqual(requestsForConversation(data,'bot','bot',true).map((r:{id:string})=>r.id),['pending','resolved']);
 assert.deepEqual(requestsForConversation(data,'group','group').map((r:{id:string})=>r.id),['group-pending']);
});
test('view request scrolls only the conversation and focuses without an answer side effect', () => {
 let scroll:any, focus:any, lookedUp='';
 const scroller={scrollTop:1800,getBoundingClientRect:()=>({top:80}),scrollTo:(options:any)=>{scroll=options;}};
 const card={getBoundingClientRect:()=>({top:-1700}),closest:(selector:string)=>{assert.equal(selector,'.conversation');return scroller;},focus:(options:any)=>{focus=options;}};
 assert.equal(focusConversationRequest('fixture/id',{getElementById:(id:string)=>{lookedUp=id;return card;}} as any),true);
 assert.equal(lookedUp,requestCardId('fixture/id'));assert.deepEqual(scroll,{top:8,behavior:'auto'});assert.deepEqual(focus,{preventScroll:true});
 assert.equal(focusConversationRequest('missing',{getElementById:()=>null} as any),false);
});
test('Chinese and literal internal spaces are preserved; IME Enter never sends', () => {
 const sample='中文输入：p w d 是什么？';
 assert.equal(messageSegments(sample).map(segment=>segment.text).join(''),sample);
 assert.equal(isComposerSubmit({key:'Enter',isComposing:true}),false);
 assert.equal(isComposerSubmit({key:'Enter',nativeEvent:{isComposing:true,keyCode:229}}),false);
 assert.equal(isComposerSubmit({key:'Enter',nativeEvent:{keyCode:229}}),false);
 assert.equal(isComposerSubmit({key:'Enter',shiftKey:true}),false);
 assert.equal(isComposerSubmit({key:'Enter'}),true);
});
