import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/daemon/runtime/store.ts';
import { ChannelMessageReader } from '../src/daemon/runtime/channel-messages.ts';
import { MessageReactionError, setAgentMessageReaction, setMessageReaction, validReactionEmoji } from '../src/pi/message-reactions.ts';
import { registerReactionTool } from '../src/pi/reaction-tool.ts';
import type { Envelope, Outbound } from '../src/pi/types.ts';
import type { ReactionChange } from '../src/pi/message-reactions.ts';
import { methods } from '../src/sdk/protocol/index.ts';
import { Value } from 'typebox/value';

function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'pibo-reactions-')), path = join(dir, 'test.db');
    const store = new Store(path);
    return { store, path, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const input = (id: string, extra: Partial<Envelope> = {}): Envelope => ({ id, to: 'bot-a', from: 'user', kind: 'user', text: 'same text', taskId: id, replyTo: null, hop: 0, key: id, state: 'queued', createdAt: 1, route: {channelId: 'alpha', conversationId: 'conversation', threadId: 'thread', senderId: 'user'}, ...extra });
const change = (messageId: string, extra: Partial<ReactionChange> = {}): ReactionChange => ({messageId, direction: 'inbound', channelId: 'alpha', conversationId: 'conversation', threadId: 'thread', emoji: '❤️', present: true, ...extra});
const forbidden = (error: unknown) => error instanceof MessageReactionError && error.reason === 'forbidden';

test('reaction identifies message and direction, is idempotent and preserves another actor', () => {
    const f = fixture();
    try {
        f.store.put('inbox', input('one')); f.store.put('inbox', input('two'));
        const outbound: Outbound = {id:'one',botId:'bot-a',text:'same text',state:'pending',key:'reply',taskId:'one',replyTo:'one',createdAt:2,route:input('one').route};
        f.store.put('outbox',outbound);
        assert.equal(setMessageReaction(f.store,change('one'),'user:a').changed,true);
        const seq=f.store.events.seq;
        assert.equal(setMessageReaction(f.store,change('one'),'user:a').changed,false);
        assert.equal(f.store.events.seq,seq,'duplicate set produces no event');
        assert.equal(f.store.get<Envelope>('inbox','two')?.reactions,undefined);
        assert.equal(f.store.get<Outbound>('outbox','one')?.reactions,undefined);
        setMessageReaction(f.store,change('one'),'user:b');
        assert.deepEqual(setMessageReaction(f.store,change('one',{present:false}),'user:a').reactions.map(r=>r.actorId),['user:b']);
        const removed=f.store.events.seq;
        assert.equal(setMessageReaction(f.store,change('one',{present:false}),'user:a').changed,false);
        assert.equal(f.store.events.seq,removed);
    } finally { f.close(); }
});

test('reactions survive stale runtime transitions, restart and channel replay without text changes', () => {
    const f=fixture(); let reopened:Store|undefined;
    try {
        const stale=input('one'); f.store.put('inbox',stale);
        setMessageReaction(f.store,change('one'),'user:a');
        f.store.put('inbox',{...stale,state:'done'});
        assert.equal(f.store.get<Envelope>('inbox','one')?.reactions?.length,1);
        f.store.close(); reopened=new Store(f.path);
        assert.equal(reopened.get<Envelope>('inbox','one')?.reactions?.length,1);
        const reader=new ChannelMessageReader(f.path,{channels:['alpha']});
        try {
            const message=reader.list({channelId:'alpha'}).items[0];
            assert.equal(message.text,'same text'); assert.equal(message.reactions?.[0].actorId,'user:a');
            assert.ok(reader.changes({channelId:'alpha'}).items.some(m=>m.reactions?.length===1));
            setMessageReaction(reopened,change('one',{present:false}),'user:a');
            reopened.put('inbox',{...stale,reactions:[{actorId:'user:a',emoji:'❤️',createdAt:1}],state:'done'});
            assert.deepEqual(reopened.get<Envelope>('inbox','one')?.reactions,[],'stale write cannot resurrect removed reaction');
        } finally { reader.close(); }
    } finally { reopened?.close(); rmSync(join(f.path,'..'),{recursive:true,force:true}); }
});

test('scope and agent ownership reject cross-conversation, other bots and internal inputs', () => {
    const f=fixture();
    try {
        const source=input('source'); f.store.put('inbox',source); f.store.put('inbox',input('target')); f.store.put('inbox',input('other-bot',{to:'bot-b'}));
        f.store.put('inbox',input('internal',{kind:'job'}));
        for(const extra of [{channelId:'beta'},{conversationId:'other'},{threadId:null}]) assert.throws(()=>setMessageReaction(f.store,change('target',extra),'user:a'),forbidden);
        assert.throws(()=>setAgentMessageReaction(f.store,source,{messageId:'other-bot',direction:'inbound',emoji:'👍',present:true}),forbidden);
        assert.throws(()=>setMessageReaction(f.store,change('internal'),'user:a'),forbidden);
        assert.throws(()=>setAgentMessageReaction(f.store,{...source,to:'bot-b'},{messageId:'target',direction:'inbound',emoji:'👍',present:true}),forbidden);
        const result=setAgentMessageReaction(f.store,source,{messageId:'target',direction:'inbound',emoji:'👍',present:true});
        assert.equal(result.actorId,'bot:bot-a'); assert.equal(f.store.list('outbox').length,0);
    } finally { f.close(); }
});

test('reacting to a failed message does not replay its execution failure transition',()=>{
    const f=fixture();
    try {
        f.store.put('inbox',input('failed',{state:'failed',error:'synthetic failure'}));
        const seq=f.store.events.seq;
        setMessageReaction(f.store,change('failed'),'user:a');
        assert.deepEqual(f.store.events.read(seq).map(e=>e.method),['item/updated']);
    } finally {f.close();}
});

test('group input canonical id and per-bot ids share one reaction, while outbound retains its envelope', () => {
    const f=fixture();
    try {
        f.store.put('groups',{id:'alpha',memberIds:['bot-a','bot-b']});
        const a=input('a',{groupMessageId:'public'}),b=input('b',{groupMessageId:'public',to:'bot-b'});
        f.store.put('inbox',a);f.store.put('inbox',b);
        f.store.put('group_messages',{id:'public',messageId:'public',direction:'inbound',channelId:'alpha',conversationId:'conversation',threadId:'thread',text:'same text'});
        setAgentMessageReaction(f.store,a,{messageId:'a',direction:'inbound',emoji:'👍',present:true});
        for(const [table,id] of [['inbox','a'],['inbox','b'],['group_messages','public']]) assert.equal(f.store.get<any>(table,id).reactions[0].actorId,'bot:bot-a');
        const seq=f.store.events.seq;
        assert.equal(setAgentMessageReaction(f.store,a,{messageId:'public',direction:'inbound',emoji:'👍',present:true}).changed,false);
        assert.equal(f.store.events.seq,seq);
        const out:Outbound={id:'reply',botId:'bot-a',taskId:'a',replyTo:'a',key:'reply',text:'answer',state:'pending',createdAt:2,route:a.route};
        f.store.put('outbox',out);
        setMessageReaction(f.store,change('reply',{direction:'outbound'}),'user:a');
        const saved=f.store.get<Outbound>('outbox','reply')!;
        assert.equal(saved.id,'reply');assert.equal(saved.state,'pending');assert.equal(saved.replyTo,'a');assert.equal(saved.route?.channelId,'alpha');
        assert.equal(f.store.get<any>('group_messages','reply').reactions.length,1);
        f.store.put('groups',{id:'alpha',memberIds:['bot-b']});
        assert.throws(()=>setAgentMessageReaction(f.store,a,{messageId:'public',direction:'inbound',emoji:'😂',present:true}),forbidden);
    } finally { f.close(); }
});

test('one emoji only, bounded storage and no caller-supplied actor in RPC', () => {
    for(const value of ['❤️','👍🏽','👨‍👩‍👧‍👦','🇨🇳','1️⃣']) assert.equal(validReactionEmoji(value),true,value);
    for(const value of ['','hello','❤️❤️','<script>','a❤️','👍\n']) assert.equal(validReactionEmoji(value),false,value);
    assert.equal(Value.Check(methods['message/setReaction'].params,{...change('one'),actorId:'bot:someone'}),false);
    const f=fixture();
    try {
        f.store.put('inbox',input('one',{reactions:Array.from({length:256},(_,n)=>({actorId:'user:'+n,emoji:'❤️',createdAt:1}))}));
        assert.throws(()=>setMessageReaction(f.store,change('one'),'user:overflow'),(e:any)=>e.reason==='capacity');
        assert.equal(setMessageReaction(f.store,change('one',{present:false}),'user:0').changed,true);
    } finally {f.close();}
});

test('tool uses inherited current source, binds bot actor and creates no delivery', async () => {
    const f=fixture(); let tool:any,guard=0;
    try {
        const source=input('one');f.store.put('inbox',source);
        registerReactionTool({registerTool:t=>tool=t},{runtime:{store:f.store,assertTaskCurrent:(e:Envelope)=>{assert.equal(e,source);guard++;}} as any,own:(id,mutation)=>{assert.equal(id,'one');assert.equal(mutation,true);return source;},result:v=>v});
        const p={message_id:'one',direction:'inbound',emoji:'❤️',present:true,source_message_id:'one'};
        const result=await tool.execute('call',p);assert.equal(result.actorId,'bot:bot-a');assert.equal(guard,1);
        assert.equal((await tool.execute('call-again',p)).changed,false);
        assert.equal(f.store.list('outbox').length,0);
    } finally {f.close();}
});

