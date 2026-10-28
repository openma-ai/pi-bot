import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, readdirSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { LocalTrace } from '../src/daemon/observability/local-trace.ts';
import { ProviderTiming, providerRequestShape, toolTimingOutcome } from '../src/pi/latency.ts';
import { FrontendLatency } from '../src/sdk/frontend-latency.ts';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';
import { piSessionFactory } from '../src/pi/session-factory.ts';
import { RequestBroker } from '../src/daemon/requests/request-broker.ts';
import { derive } from '../src/daemon/events/derive.ts';

const secret = 'SYNTHETIC_PRIVATE_BODY Bearer xyz https://fixture.invalid/?code=PRIVATE';
const scope = { inputId: 'synthetic-message', turnId: 'trn_00000000-0000-0000-0000-000000000001' };
function spans(records: any[]) {
    // OTLP/JSON protobuf rules: lowerCamelCase fields, hex IDs (not base64),
    // 64-bit integer time fields encoded as decimal strings, enum numbers,
    // AnyValue typed fields. See docs/local-latency.md for official references.
    return records.flatMap(r => {
        assert.deepEqual(Object.keys(r), ['resourceSpans']);
        return r.resourceSpans.flatMap((resource: any) => resource.scopeSpans.flatMap((s: any) => s.spans.map((span: any) => {
            assert.match(span.traceId,/^[a-f0-9]{32}$/); assert.match(span.spanId,/^[a-f0-9]{16}$/);
            if (span.parentSpanId) assert.match(span.parentSpanId,/^[a-f0-9]{16}$/);
            assert.notEqual(span.spanId,span.parentSpanId);
            for (const key of ['startTimeUnixNano','endTimeUnixNano']) assert.match(span[key],/^\d+$/);
            assert.ok(BigInt(span.endTimeUnixNano)>=BigInt(span.startTimeUnixNano));
            assert.ok([1,3].includes(span.kind)); assert.ok([0,1,2].includes(span.status.code));
            for (const a of span.attributes) { assert.match(a.key,/^pibo\./); assert.equal(Object.keys(a.value).length,1); assert.ok('stringValue' in a.value || Number.isFinite(a.value.doubleValue)); }
            return span;
        })));
    });
}
const read = (dir: string) => readFileSync(join(dir,'latency.otlp.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
const attrs = (span: any) => Object.fromEntries(span.attributes.map((a: any)=>[a.key.replace('pibo.',''),a.value.stringValue??a.value.doubleValue]));

test('provider boundaries retain first event/content separately and finish exactly once', () => {
    const records: any[]=[]; const timing=new ProviderTiming(e=>records.push(e));
    timing.event('start'); timing.event('thinking_delta'); timing.event('text_delta'); timing.end('ok',{input:3,output:2,cacheRead:1}); timing.end('error');
    assert.deepEqual(records.map(r=>r.phase),['start','first_event','first_content','end']);
    assert.equal(new Set(records.map(r=>r.id)).size,1); assert.equal(records.at(-1).inputTokens,3);
    assert.doesNotThrow(()=>new ProviderTiming(()=>{throw Error(secret);}).end('error'));
});
test('request shape observes actual declared schema size without retaining prompt/schema bodies',()=>{
    const value=providerRequestShape({systemPrompt:secret,tools:[{name:'send_message',description:secret,parameters:{secret}},{name:secret}],messages:[{content:secret}]});
    assert.equal(value.systemPromptCharacters,secret.length);assert.equal(value.declaredToolCount,2);
    assert.deepEqual(value.declaredToolNames,['send_message','other']);assert.equal(value.messageCount,1);
    assert.equal(value.promptAndToolsChar4Estimate,Math.ceil((value.systemPromptCharacters!+value.toolSchemaCharacters!)/4));
    assert.doesNotMatch(JSON.stringify(value),/SYNTHETIC|Bearer|fixture.invalid|PRIVATE/);
    const replay=providerRequestShape({messages:[{role:'system',content:'',sections:{preamble:'test'},toolsAdded:[{name:'send_message',description:'safe',parameters:{}}]},{role:'system',content:'',toolsRemoved:[{name:'send_message'}],toolsAdded:[{name:'bash',description:'safe',parameters:{}}]}]});
    assert.equal(replay.systemPromptCharacters,4);assert.deepEqual(replay.declaredToolNames,['bash']);
});
test('OTLP shape, safe fields, bounded rotation and failure/symlink isolation', () => {
    const dir=mkdtempSync(join(tmpdir(),'pibo-local-trace-'));
    try {
        const trace=new LocalTrace(dir,4096);
        for(let n=0;n<20;n++) trace.boundary(scope,{kind:'provider',phase:'end',id:secret,elapsedMs:3,outcome:'error',inputTokens:4,...{body:secret,error:secret,tool:secret}} as any);
        const files=readdirSync(dir); assert.deepEqual(files.sort(),['latency.otlp.jsonl','latency.otlp.jsonl.1']);
        for(const file of files) { assert.ok(statSync(join(dir,file)).size<=4096);assert.equal(statSync(join(dir,file)).mode&0o777,0o600); }
        const raw=readFileSync(join(dir,files[0]),'utf8');assert.doesNotMatch(raw,/SYNTHETIC|Bearer|fixture.invalid|PRIVATE/);
        const parsed=spans(read(dir));assert.ok(parsed.length);assert.equal(attrs(parsed[0]).tool,'other');
        const target=join(dir,'do-not-touch');writeFileSync(target,'preserve');
        const linked=join(dir,'linked');symlinkSync(target,linked);
        assert.doesNotThrow(()=>new LocalTrace(linked).point(scope,'run.start'));
        assert.equal(readFileSync(target,'utf8'),'preserve');
    } finally {rmSync(dir,{recursive:true,force:true});}
});
test('ended cancellations, blocked requests and uncertain runs are not successful spans', () => {
    const dir=mkdtempSync(join(tmpdir(),'pibo-trace-status-'));
    try {
        const trace=new LocalTrace(dir);
        for (const outcome of ['ok','error','cancelled','blocked',undefined] as const)
            trace.boundary(scope,{kind:'provider',phase:'end',id:String(outcome),elapsedMs:1,outcome});
        for (const status of ['completed','failed','uncertain','interrupted','yielded','cancelled','expired',undefined])
            trace.point(scope,'run.end',{status,elapsedMs:1});
        assert.deepEqual(spans(read(dir)).map(s=>s.status.code),[1,2,0,0,0,1,2,0,0,0,0,0,0]);
    } finally {rmSync(dir,{recursive:true,force:true});}
});
test('background tool return classification does not turn cancelled or uncertain cells into success',()=>{
    assert.equal(toolTimingOutcome(false,'cancelled'),'cancelled');
    assert.equal(toolTimingOutcome(false,'interrupted'),'cancelled');
    assert.equal(toolTimingOutcome(false,'uncertain'),'uncertain');
    assert.equal(toolTimingOutcome(false,'blocked'),'blocked');
    for(const state of ['failed','persistence_failed','timed_out'])assert.equal(toolTimingOutcome(false,state),'error');
    assert.equal(toolTimingOutcome(true,'completed'),'error');
    assert.equal(toolTimingOutcome(false,'completed'),'ok');
    assert.equal(toolTimingOutcome(false,'running'),'ok','only the running receipt returned, not the job completion');
});
test('nested tool spans preserve lineage, hash IDs and isolate repeated tool IDs across runs',()=>{
    const dir=mkdtempSync(join(tmpdir(),'pibo-trace-parent-'));
    try {
        const trace=new LocalTrace(dir);
        const other={...scope,turnId:'trn_00000000-0000-0000-0000-000000000002'};
        for(const current of [scope,other]) {
            trace.point(current,'run.end',{status:'completed'});
            trace.boundary(current,{kind:'tool',phase:'end',id:secret,tool:'codemode',outcome:'ok',elapsedMs:1});
            trace.boundary(current,{kind:'tool',phase:'start',id:'child',parentToolCallId:secret,tool:'send_message',elapsedMs:0});
            trace.boundary(current,{kind:'tool',phase:'end',id:'child',parentToolCallId:secret,tool:'send_message',outcome:'ok',elapsedMs:1});
        }
        const all=spans(read(dir));assert.equal(new Set(all.map(s=>s.spanId)).size,all.length);
        for(let i=0;i<all.length;i+=4) {
            const [run,parent,start,child]=all.slice(i,i+4);
            assert.equal(parent.parentSpanId,run.spanId);assert.equal(child.parentSpanId,parent.spanId);assert.equal(start.parentSpanId,child.spanId);
        }
        assert.doesNotMatch(JSON.stringify(read(dir)),/SYNTHETIC|Bearer|fixture.invalid|PRIVATE/);
    } finally {rmSync(dir,{recursive:true,force:true});}
});
test('frontend receive-to-layout-commit shares backend trace and is bounded/clearable', async () => {
    const dir=mkdtempSync(join(tmpdir(),'pibo-client-trace-'));
    try {
        new LocalTrace(dir).point(scope,'run.end',{elapsedMs:5,status:'completed'});
        const frontend=new FrontendLatency();frontend.received({primaryInputId:scope.inputId,turnId:scope.turnId!,itemId:secret,serverAt:Date.now()-10});
        await frontend.committed(secret); await frontend.committed(secret);
        const [client]=spans(frontend.snapshot());const [server]=spans(read(dir));
        assert.equal(client.traceId,server.traceId);assert.equal(client.parentSpanId,server.spanId);
        assert.ok(attrs(client).receiveToCommitMs>=0);assert.ok('serverToReceiveClockDeltaMs' in attrs(client));
        const remounted=new FrontendLatency();remounted.received({primaryInputId:scope.inputId,turnId:scope.turnId!,itemId:secret,serverAt:Date.now()-10});
        await remounted.committed(secret);const [afterRemount]=spans(remounted.snapshot());
        assert.equal(afterRemount.traceId,client.traceId);assert.equal(afterRemount.parentSpanId,client.parentSpanId);assert.notEqual(afterRemount.spanId,client.spanId);
        assert.doesNotMatch(JSON.stringify(frontend.snapshot()),/SYNTHETIC|Bearer|PRIVATE|fixture.invalid/);
        frontend.received({primaryInputId:scope.inputId,turnId:scope.turnId!,itemId:'cancel',serverAt:0});const p=frontend.committed('cancel');frontend.clear();await p;assert.deepEqual(frontend.snapshot(),[]);
        for(let i=0;i<258;i++){frontend.received({primaryInputId:scope.inputId,turnId:scope.turnId!,itemId:String(i),serverAt:0});await frontend.committed(String(i));}
        assert.equal(frontend.snapshot().length,256);
    } finally {rmSync(dir,{recursive:true,force:true});}
});
test('usage updates never masquerade as a new run admission',()=>{
    const turn={id:scope.turnId,status:'running',usage:{input:0}};
    assert.equal(derive('turns',undefined,turn,{})[0].method,'turn/started');
    assert.equal(derive('turns',turn,{...turn,usage:{input:3}},{})[0].method,'turn/updated');
});
test('actual Pi fixture correlates queue/run/provider/tool/request/delivery without payload export', {timeout:15000}, async()=>{
    const dir=mkdtempSync(join(tmpdir(),'pibo-latency-sdk-'));
    const faux=fauxProvider({provider:'latency-fixture',models:[{id:'fixture',contextWindow:128000,maxTokens:4096}],tokensPerSecond:1000000});
    const models=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,modelsStorePath:join(dir,'models.json'),refreshOnCreate:false});
    faux.setResponses([fauxAssistantMessage([fauxToolCall('send_message',{text:secret,key:'reply'},{id:'reply-tool'})],{stopReason:'toolUse'}),fauxAssistantMessage('private reasoning fixture')]);
    const runtime=new BotRuntime(join(dir,'runtime.db'),piSessionFactory({dir:join(dir,'sessions'),modelRuntime:models,model:faux.getModel(),extensions:[pi=>pi.registerProvider(faux.provider)]}));
    let broker: RequestBroker|undefined;
    try {
        const bot=runtime.createBot('fixture');const input=runtime.accept({to:bot.id,text:secret,key:'fixture'});await runtime.idle();
        await runtime.deliver(async()=>{});
        broker=new RequestBroker(runtime,new Map());const q=broker.create('approval',input,{tool:'fixture',args:secret});broker.resolve(q.id,{decision:'deny'},'host');
        const records=read(join(dir,'diagnostics')), trace=spans(records), names=trace.map(s=>s.name);
        for(const name of ['message.queued','message.admitted','run.start','session.ready','provider.start','provider.first_event','provider.first_content','provider.end','tool.start','tool.end','request.pending','request.resolved','delivery.pending','delivery.sending','delivery.delivered','run.end']) assert.ok(names.includes(name),name);
        assert.equal(names.filter(n=>n==='provider.start').length,2);assert.equal(names.filter(n=>n==='provider.end').length,2);
        assert.equal(new Set(trace.map(s=>s.traceId)).size,1);assert.equal(new Set(trace.map(s=>s.spanId)).size,trace.length);
        assert.doesNotMatch(JSON.stringify(records),/SYNTHETIC|Bearer|fixture.invalid|PRIVATE|private reasoning|reply-tool/);
        assert.equal(runtime.store.list<any>('turns')[0].status,'completed');
        assert.equal(runtime.store.events.read(0).filter(e=>e.method==='turn/started').length,1);
    } finally {broker?.close();await runtime.close();rmSync(dir,{recursive:true,force:true});}
});
