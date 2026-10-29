import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {Socket} from 'node:net';
import {tmpdir} from 'node:os';
import {TracerProvider} from '@opentelemetry/sdk-trace';
import {LocalTrace} from '../src/daemon/observability/local-trace.ts';
import {FrontendLatency} from '../src/sdk/frontend-latency.ts';
const pause=()=>new Promise<void>(r=>setTimeout(r,1));
const scope=(n:number)=>({inputId:'fixture-'+n,turnId:'trn_00000000-0000-0000-0000-'+String(n).padStart(12,'0')});
const read=(dir:string)=>readFileSync(join(dir,'latency.otlp.jsonl'),'utf8').trim().split('\n').flatMap(l=>JSON.parse(l).resourceSpans[0].scopeSpans[0].spans);

test('real SDK, asynchronous concurrent context isolation, flush and W3C frontend parent',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pibo-otel-standard-'));const local=new LocalTrace(dir);
 try{
  assert.ok((local as any).provider instanceof TracerProvider);
  const carrier=new Map<number,string>();
  await Promise.all([1,2,3].map(async n=>{
   const s=scope(n);local.point(s,'run.start');
   await local.withScope(s,async()=>{
    const before=local.activeContext();assert.ok(before);await pause();
    assert.deepEqual(local.activeContext(),before);
    carrier.set(n,local.traceparent(s));
    local.boundary(s,{kind:'tool',phase:'start',id:'same-id',elapsedMs:0,tool:'codemode'});
    await pause();local.boundary(s,{kind:'tool',phase:'end',id:'child',parentToolCallId:'same-id',elapsedMs:1,tool:'send_message',outcome:'ok'});
    local.boundary(s,{kind:'tool',phase:'end',id:'same-id',elapsedMs:2,tool:'codemode',outcome:'ok'});
   });
   assert.equal(local.activeContext(),undefined);local.point(s,'run.end',{status:'completed'});
  }));
  await local.forceFlush();const all=read(dir);assert.equal(new Set(all.map(s=>s.traceId)).size,3);
  for(const n of [1,2,3]){
   const traceId=carrier.get(n)!.split('-')[1],items=all.filter(s=>s.traceId===traceId),root=items.find(s=>s.name==='run.end');
   const tools=items.filter(s=>s.name==='tool.end');const parent=tools.find(s=>s.attributes.some((a:any)=>a.key==='pibo.tool'&&a.value.stringValue==='codemode'));
   assert.equal(parent.parentSpanId,root.spanId);assert.equal(tools.find(s=>s!==parent).parentSpanId,parent.spanId);
  }
  const frontend=new FrontendLatency();frontend.received({primaryInputId:scope(1).inputId,turnId:scope(1).turnId,itemId:'fixture-item',serverAt:Date.now()});await frontend.committed('fixture-item');await frontend.forceFlush();
  const client=(frontend.snapshot()[0] as any).resourceSpans[0].scopeSpans[0].spans[0];assert.equal(client.traceId,carrier.get(1)!.split('-')[1]);assert.equal(client.parentSpanId,carrier.get(1)!.split('-')[2]);await frontend.shutdown();
 }finally{await local.shutdown();rmSync(dir,{recursive:true,force:true});}
});

test('shutdown ends open spans as cancelled, is idempotent, rejects writes after close',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pibo-otel-cancel-')),local=new LocalTrace(dir);
 try{local.point(scope(1),'run.start');local.boundary(scope(1),{kind:'provider',phase:'start',id:'pending',elapsedMs:0});await local.shutdown();const before=readFileSync(join(dir,'latency.otlp.jsonl'),'utf8');await local.shutdown();local.point(scope(1),'run.end',{status:'completed'});assert.equal(readFileSync(join(dir,'latency.otlp.jsonl'),'utf8'),before);const spans=read(dir).filter(s=>s.name.endsWith('.end'));assert.equal(spans.length,2);assert.ok(spans.every(s=>s.status.code===0&&s.attributes.some((a:any)=>a.key==='pibo.outcome'&&a.value.stringValue==='cancelled')));}finally{rmSync(dir,{recursive:true,force:true});}
});

test('poisoned exporter/resource environment cannot cause remote export or PII retention; bounded retention',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pibo-otel-private-'));const keys=['OTEL_TRACES_EXPORTER','OTEL_EXPORTER_OTLP_ENDPOINT','OTEL_RESOURCE_ATTRIBUTES','OTEL_SERVICE_NAME','OTEL_TRACES_SAMPLER'];const previous=keys.map(k=>process.env[k]);const fetchBefore=globalThis.fetch;const connectBefore=Socket.prototype.connect;let calls=0,connections=0;
 try{Socket.prototype.connect=function(){connections++;throw Error('no network permitted in trace fixture');} as typeof Socket.prototype.connect;Object.assign(process.env,{OTEL_TRACES_EXPORTER:'otlp',OTEL_EXPORTER_OTLP_ENDPOINT:'https://never-contact.invalid/private',OTEL_RESOURCE_ATTRIBUTES:'user.email=private@example.invalid',OTEL_SERVICE_NAME:'SECRET_ACCOUNT',OTEL_TRACES_SAMPLER:'always_off'});globalThis.fetch=(async()=>{calls++;throw Error('must not export');}) as any;
  const local=new LocalTrace(dir,4096);for(let n=0;n<50;n++)local.boundary(scope(n),{kind:'provider',phase:'end',id:'secret-token-'+n,elapsedMs:1,outcome:'error',...{rawBody:'private@example.invalid Bearer PRIVATE',tool:'secret-token',declaredToolNames:['SECRET_ACCOUNT']}} as any);await local.forceFlush();await local.shutdown();assert.equal(calls,0);assert.equal(connections,0);
  assert.deepEqual(readdirSync(dir).sort(),['latency.otlp.jsonl','latency.otlp.jsonl.1']);for(const f of readdirSync(dir)){assert.ok(statSync(join(dir,f)).size<=4096);assert.equal(statSync(join(dir,f)).mode&0o777,0o600);assert.doesNotMatch(readFileSync(join(dir,f),'utf8'),/PRIVATE|SECRET_ACCOUNT|Bearer|secret-token|private@example|never-contact/);}
 }finally{Socket.prototype.connect=connectBefore;globalThis.fetch=fetchBefore;keys.forEach((k,i)=>{if(previous[i]===undefined)delete process.env[k];else process.env[k]=previous[i];});rmSync(dir,{recursive:true,force:true});}
});
