import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotRuntime} from '../src/daemon/runtime/runtime.ts';
const wait=()=>new Promise<void>(r=>setTimeout(r,2));
test('runtime run hook keeps concurrent async contexts and flushes after sessions close',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pibo-otel-runtime-'));const seen=new Map<string,string>();let closed=0;
 const runtime=new BotRuntime(join(dir,'runtime.db'),async(_bot,host)=>({
  async run(e){const trace=(host as BotRuntime).trace,ctx=trace.activeContext();assert.ok(ctx);seen.set(e.id,ctx.traceId);await wait();assert.deepEqual(trace.activeContext(),ctx);if(e.text==='synthetic failure')throw Error('synthetic failure');},
  async close(){closed++;}
 }));
 try{const a=runtime.createBot('synthetic-a'),b=runtime.createBot('synthetic-b');runtime.accept({to:a.id,text:'synthetic success',key:'a'});runtime.accept({to:b.id,text:'synthetic failure',key:'b'});await runtime.idle();assert.equal(new Set(seen.values()).size,2);assert.equal(runtime.trace.activeContext(),undefined);await runtime.close();assert.equal(closed,2);
  const records=readFileSync(join(dir,'diagnostics/latency.otlp.jsonl'),'utf8').trim().split('\n').flatMap(l=>JSON.parse(l).resourceSpans[0].scopeSpans[0].spans);const roots=records.filter(s=>s.name==='run.end');assert.deepEqual(roots.map(s=>s.status.code).sort(),[1,2]);assert.equal((runtime.trace as any).active.size,0);
 }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});
test('forceClose ends unfinished local spans before returning without touching a provider',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pibo-otel-forced-'));const runtime=new BotRuntime(join(dir,'runtime.db'),async()=>({run:async()=>{},close:async()=>{}}));
 try{runtime.trace.point({inputId:'fixture-open',turnId:'trn_00000000-0000-0000-0000-000000000099'},'run.start');runtime.forceClose();const raw=readFileSync(join(dir,'diagnostics/latency.otlp.jsonl'),'utf8');assert.match(raw,/cancelled/);assert.equal((runtime.trace as any).active.size,0);await runtime.trace.forceFlush();assert.equal(readFileSync(join(dir,'diagnostics/latency.otlp.jsonl'),'utf8'),raw);}finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});
