import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutMessages, messageSender, needsTimeSeparator, messageTimes, type LayoutMessage} from '../src/gui/message-layout.ts';
import {senderLabelColor, contrastRatio} from '../src/gui/identity-color.ts';
const bots=[{id:'a',name:'Alpha'},{id:'b',name:'Beta'}];
const start=Date.parse('2026-10-14T15:58:00Z');
const m=(id:string,sender='a',offset=0,extra:any={}):LayoutMessage=>({messageId:id,direction:'inbound',sourceKind:'bot',sender,botId:'b',receivedAt:start+offset,status:'received',...extra});
test('group labels start a run and only its last bubble carries the avatar',()=>{
 const rows=layoutMessages([m('1'),m('2','a',1000),m('3','b',2000)],true,bots,'Asia/Shanghai');
 assert.deepEqual(rows.map(r=>[r.runStart,r.runEnd]),[[true,false],[false,true],[true,true]]);
 assert.equal(rows[0].sender?.name,'Alpha');
});
test('user, schedule and failure boundaries never merge unrelated group attribution',()=>{
 const rows=layoutMessages([m('1'),m('2','a',1000,{sourceKind:'user'}),m('3','a',2000),m('4','a',3000,{sourceKind:'schedule'}),m('5','a',4000,{status:'failed'}),m('6','a',5000)],true,bots,'UTC');
 assert.equal(rows[1].sender,null);assert.equal(rows[3].sender,null);
 assert.ok(rows[0].runEnd && rows[2].runStart && rows[2].runEnd && rows[4].runStart && rows[4].runEnd && rows[5].runStart);
});
test('deleted and unknown senders are never borrowed from recipient or current selection',()=>{
 assert.equal(messageSender(m('x','deleted'),bots).name,'已移除的成员');
 assert.equal(messageSender(m('x','deleted'),bots).id,'deleted');
 assert.equal(messageSender(m('x','',0),bots).name,'未知成员');
 assert.equal(messageSender(m('x','',0,{direction:'outbound'}),bots).name,'Beta');
});
test('day boundary and five-minute gaps produce centered separators in the requested timezone',()=>{
 const a=m('a'), midnight=m('b','a',120000);
 assert.equal(needsTimeSeparator(midnight,a,'Asia/Shanghai'),true);
 assert.equal(needsTimeSeparator(midnight,a,'UTC'),false);
 assert.equal(needsTimeSeparator(m('c','a',300000),a,'UTC'),true);
 assert.equal(needsTimeSeparator(m('c','a',299999),a,'UTC'),false);
 const rows=layoutMessages([a,midnight],true,bots,'Asia/Shanghai');assert.ok(rows.every(r=>r.runStart&&r.runEnd));
});
test('full real ISO time is retained; invalid timestamps do not become fabricated current time',()=>{
 const t=messageTimes(start,'Asia/Shanghai');assert.equal(t.iso,'2026-10-14T15:58:00.000Z');assert.match(t.full,/2026/);
 assert.equal(messageTimes(NaN).full,'时间未知');assert.equal(messageTimes(NaN).iso,undefined);
});
test('stream deltas and prepended history preserve message identities and interior run decisions',()=>{
 const history=[m('1'),m('2','a',1000)], stream=m('stream:tool','a',2000,{streaming:true,text:'partial'});
 const before=layoutMessages([...history,stream],true,bots,'UTC');
 const delta=layoutMessages([...history,{...stream,text:'partial plus delta'}],true,bots,'UTC');
 assert.deepEqual(before.map(r=>[r.message.messageId,r.separator,r.runStart,r.runEnd,r.time]),delta.map(r=>[r.message.messageId,r.separator,r.runStart,r.runEnd,r.time]));
 const prepended=layoutMessages([m('older','b',-600000),...history,stream],true,bots,'UTC');
 assert.deepEqual(before.slice(1),prepended.slice(2));
});
test('single chat does not gain group avatars or sender-run labels',()=>{
 assert.ok(layoutMessages([m('1'),m('2')],false,bots,'UTC').every(r=>r.sender===null&&!r.runStart&&!r.runEnd));
});
test('sender identity labels have readable contrast even for very dark custom colors',()=>{
 for(const color of ['#000000','#173252','#48b39f','#ffffff'])assert.ok(contrastRatio(senderLabelColor('a',{color}),'#111111')>=4.5);
});

test('real sender avatar configuration is preserved by reference, including uploaded picture identity',()=>{
 const custom={id:'a',name:'Photo member',avatar:{color:'#123456',shape:4,picture:'fixture-hash'}};
 assert.equal(messageSender(m('photo'),[custom]).bot,custom);
});
test('DST repeated local time still follows real elapsed time and retains zone disambiguation',()=>{
 const a=m('a','a',0,{receivedAt:Date.parse('2026-11-01T05:30:00Z')});
 const b=m('b','a',0,{receivedAt:Date.parse('2026-11-01T06:30:00Z')});
 assert.ok(needsTimeSeparator(b,a,'America/New_York'));
 assert.notEqual(messageTimes(a.receivedAt,'America/New_York').full,messageTimes(b.receivedAt,'America/New_York').full);
});

test('an uncertain same-sender message closes both neighboring runs',()=>{
 const rows=layoutMessages([m('1'),m('2','a',1000,{status:'uncertain'}),m('3','a',2000)],true,bots,'UTC');
 assert.ok(rows.every(r=>r.runStart&&r.runEnd));
});
