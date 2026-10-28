import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, getCurrentTools } from '@earendil-works/pi-ai';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';
import { piSessionFactory } from '../src/pi/session-factory.ts';
import { hasValidToolPairs } from '../src/pi/context.ts';

for (const variant of ['nested-only','outer-source','wrong-inner','legacy-single'] as const)
test(`codemode source binding: ${variant}`,{timeout:15000},async()=>{
    const dir=await mkdtemp(join(tmpdir(),'pibo-codemode-source-'));
    const faux=fauxProvider({provider:'source-fixture',models:[{id:'fixture',contextWindow:128000,maxTokens:4096}],tokensPerSecond:1000000});
    const models=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,modelsStorePath:join(dir,'models.json'),refreshOnCreate:false,allowModelNetwork:false});
    let schema:any;const streamSimple=(models.streamSimple as any).bind(models);
    (models as any).streamSimple=(...args:any[])=>{schema=getCurrentTools(args[1].messages).find((t:any)=>t.name==='codemode');return streamSimple(...args);};
    const runtime=new BotRuntime(join(dir,'runtime.db'),piSessionFactory({dir:join(dir,'sessions'),modelRuntime:models,model:faux.getModel(),backgroundTools:{directory:join(dir,'executions'),yieldTimeMs:10000},extensions:[pi=>pi.registerProvider(faux.provider)]}));
    try {
        const bot=runtime.createBot('source fixture');let first='';
        if(variant!=='legacy-single') {
            faux.setResponses([fauxAssistantMessage('internal fixture')]);
            first=runtime.accept({to:bot.id,text:'Synthetic earlier task',key:'first',taskId:'earlier'}).id;await runtime.idle();
        }
        let source='',calls=0;
        faux.setResponses([(context:any)=>{
            calls++;
            const params:any={code:`text(await tools.send_message({text:"SYNTHETIC_DELIVERY",key:"reply",source_message_id:${JSON.stringify(variant==='wrong-inner'?first:source)}}));`};
            if(variant==='outer-source'||variant==='wrong-inner')params.source_message_id=source;
            return fauxAssistantMessage(fauxToolCall('codemode',params,{id:'source-code'}),{stopReason:'toolUse'});
        },...Array.from({length:6},()=>fauxAssistantMessage('internal fixture'))]);
        source=runtime.accept({to:bot.id,text:'Synthetic current task',key:'second',taskId:'current'}).id;
        await runtime.idle();
        const messages=SessionManager.open(runtime.listBots()[0].sessionFile!).buildSessionProjection().messages;
        assert.ok(hasValidToolPairs(messages));assert.equal(calls,1);
        assert.ok(schema.parameters.properties.source_message_id);assert.match(schema.description,/OUTER argument/);
        const output=messages.find((m:any)=>m.role==='toolResult'&&m.toolCallId==='source-code') as any;
        assert.ok(output,'paired result must be persisted');
        const outbox=runtime.store.list<any>('outbox');
        if(variant==='nested-only') {
            assert.equal(output.isError,true);assert.equal(output.details.state,'failed');
            assert.deepEqual(output.details.error,{code:'taskSourceRequired',field:'source_message_id',executed:false});
            assert.equal(outbox.length,0);assert.equal(runtime.store.list('jobs').length,0,'no execution was accepted');
        } else if(variant==='wrong-inner') {
            assert.equal(outbox.length,0,'outer binding must not authorize another task');
        } else {
            assert.equal(outbox.length,1);assert.equal(outbox[0].replyTo,source);assert.equal(output.isError,false);
            assert.equal(runtime.store.list('jobs').length,1,'one execution only');
            const trace=(await readFile(join(dir,'diagnostics','latency.otlp.jsonl'),'utf8')).trim().split('\n').flatMap(line=>JSON.parse(line).resourceSpans.flatMap((r:any)=>r.scopeSpans.flatMap((s:any)=>s.spans)));
            const tool=(s:any)=>s.attributes.find((a:any)=>a.key==='pibo.tool')?.value.stringValue;
            const outer=trace.find((s:any)=>s.name==='tool.end'&&tool(s)==='codemode');
            const inner=trace.find((s:any)=>s.name==='tool.end'&&tool(s)==='send_message');
            assert.ok(outer&&inner,'actual SDK emits both tool completion spans');
            assert.equal(inner.parentSpanId,outer.spanId,'nested SDK tool keeps the outer codemode parent');
        }
    } finally {await runtime.close();await rm(dir,{recursive:true,force:true});}
});
