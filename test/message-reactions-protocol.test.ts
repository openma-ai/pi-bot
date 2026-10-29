import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiBotDaemon } from '../src/daemon/core/daemon.ts';
import { PiBotClient } from '../src/sdk/client.ts';
import { reactionUserActor } from '../src/pi/message-reactions.ts';
test('authenticated transport identity persists across reconnect; snapshot and event replay carry reactions', async () => {
    const dir=mkdtempSync(join(tmpdir(),'pibo-reaction-protocol-'));
    let d=await PiBotDaemon.create({dataDir:dir,factory:async()=>({run:async()=>{},close:async()=>{}})});
    let api:PiBotClient|undefined;
    const host=(identity:string)=>({connect:()=>{const connection=d.connect('in-process');connection.fileOwner=identity;return connection;}});
    try {
        api=await PiBotClient.connect({transport:{inProcess:host('authenticated-user-a')}});
        const {bot}=await api.bot.create({name:'fixture'});
        const start=await api.turn.start({botId:bot.id,text:'fixture',key:'one'});await d.runtime.idle();
        const before:any=await api.daemon.snapshot({});
        const m=before.messages.find((m:any)=>m.messageId===start.inputId);
        const target={messageId:m.messageId,direction:m.direction,channelId:m.channelId,conversationId:m.conversationId,threadId:m.threadId,emoji:'❤️',present:true};
        const result=await api.message.setReaction(target);
        assert.equal(result.actorId,before.viewerReactionActorId);assert.equal(result.actorId,reactionUserActor('authenticated-user-a'));
        assert.ok(!JSON.stringify(result).includes('authenticated-user'));
        assert.ok(d.log.read(before.seq).some(e=>e.method==='item/updated'&&(e.params as any).item.message.reactions?.length===1));
        api.close();api=await PiBotClient.connect({transport:{inProcess:host('authenticated-user-a')}});
        const reconnected:any=await api.daemon.snapshot({});
        assert.equal(reconnected.viewerReactionActorId,result.actorId);assert.equal(reconnected.messages.find((m:any)=>m.messageId===start.inputId).reactions.length,1);
        assert.equal((await api.message.setReaction(target)).changed,false);
        api.close();api=await PiBotClient.connect({transport:{inProcess:host('authenticated-user-b')}});
        assert.equal((await api.message.setReaction({...target,present:false})).changed,false,'another identity cannot remove the first actor reaction');
        await assert.rejects(api.call('message/setReaction',{...target,actorId:result.actorId}),(e:any)=>e.reason==='invalidParams');
        api.close();await d.close();
        d=await PiBotDaemon.create({dataDir:dir,factory:async()=>({run:async()=>{},close:async()=>{}})});
        api=await PiBotClient.connect({transport:{inProcess:host('authenticated-user-a')}});
        assert.equal(((await api.daemon.snapshot({})) as any).messages.find((m:any)=>m.messageId===start.inputId).reactions.length,1);
    } finally {api?.close();await d.close();rmSync(dir,{recursive:true,force:true});}
});
