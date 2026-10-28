// Exercise the actual staged source/dependencies with a synthetic Pi provider.
// No host credentials, network listener, real login or paid inference.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const bundle=process.env.PIBOT_HARNESS_TEST_BUNDLE || fileURLToPath(new URL('../.harness-build/',import.meta.url));
test('staged harness correlates synthetic provider/tool/delivery traces without payloads', {timeout:20000},()=>{
  const home=mkdtempSync(join(tmpdir(),'pibo-bundled-observation-'));
  for(const dir of ['data','pi','tmp']) mkdirSync(join(home,dir),{mode:0o700});
  const code=`
    import {pathToFileURL} from 'node:url';
    import {join} from 'node:path';
    import {readFileSync} from 'node:fs';
    const bundle=process.env.PIBOT_HARNESS_ROOT, home=process.env.PIBOT_TEST_HOME;
    const load=async name=>{const root=join(bundle,'node_modules',name),pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));return import(pathToFileURL(join(root,pkg.exports?.['.']?.import??pkg.main)));};
    const {ModelRuntime}=await load('@earendil-works/pi-coding-agent');
    const {fauxProvider,fauxAssistantMessage,fauxToolCall,InMemoryCredentialStore}=await load('@earendil-works/pi-ai');
    const {BotRuntime}=await import(pathToFileURL(join(bundle,'src/daemon/runtime/runtime.ts')));
    const {piSessionFactory}=await import(pathToFileURL(join(bundle,'src/pi/session-factory.ts')));
    const faux=fauxProvider({provider:'bundle-observation-fixture',models:[{id:'fixture',contextWindow:128000,maxTokens:4096}],tokensPerSecond:1000000});
    const models=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,modelsStorePath:join(home,'models.json'),refreshOnCreate:false,allowModelNetwork:false});
    const privateText='SYNTHETIC_PRIVATE_PAYLOAD_NOT_FOR_DIAGNOSTICS';
    faux.setResponses([fauxAssistantMessage(fauxToolCall('send_message',{text:privateText,key:'reply'},{id:'fixture-tool'}),{stopReason:'toolUse'}),fauxAssistantMessage('internal fixture')]);
    const runtime=new BotRuntime(join(home,'data/runtime.db'),piSessionFactory({dir:join(home,'sessions'),modelRuntime:models,model:faux.getModel(),extensions:[pi=>pi.registerProvider(faux.provider)]}));
    try {
      const bot=runtime.createBot('Fixture');runtime.accept({to:bot.id,text:privateText,key:'fixture'});
      await runtime.idle();await runtime.deliver(async()=>{});
      const raw=readFileSync(join(home,'data/diagnostics/latency.otlp.jsonl'),'utf8');
      const spans=raw.trim().split('\\n').map(line=>JSON.parse(line)).flatMap(r=>r.resourceSpans.flatMap(r=>r.scopeSpans.flatMap(s=>s.spans)));
      console.log(JSON.stringify({status:runtime.store.list('turns')[0].status,names:spans.map(s=>s.name),traceCount:new Set(spans.map(s=>s.traceId)).size,spanCount:spans.length,uniqueSpanCount:new Set(spans.map(s=>s.spanId)).size,containsPrivatePayload:raw.includes(privateText),diagnosticFile:join(home,'data/diagnostics/latency.otlp.jsonl')}));
    } finally {await runtime.close();}
  `;
  const result=spawnSync(join(bundle,'bin/node'),['--import',join(bundle,'node_modules/tsx/dist/loader.mjs'),'--input-type=module','-e',code],{
    cwd:home,timeout:15000,encoding:'utf8',env:{HOME:home,USERPROFILE:home,TMPDIR:join(home,'tmp'),PATH:join(bundle,'bin')+':/usr/bin:/bin',NODE_ENV:'production',LANG:'en_US.UTF-8',PIBOT_HARNESS_ROOT:bundle,PIBOT_TEST_HOME:home,PI_CODING_AGENT_DIR:join(home,'pi'),PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT:join(bundle,'node_modules/@earendil-works/pi-coding-agent'),TSX_TSCONFIG_PATH:join(bundle,'tsconfig.json')}
  });
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(report.status,'completed');assert.equal(report.traceCount,1);
  assert.equal(report.uniqueSpanCount,report.spanCount);assert.equal(report.containsPrivatePayload,false);
  for(const name of ['message.queued','message.admitted','run.start','provider.start','provider.first_event','provider.first_content','provider.end','tool.start','tool.end','delivery.delivered','run.end'])assert.ok(report.names.includes(name),name);
  assert.equal(report.names.filter(n=>n==='provider.start').length,2);
  assert.equal(JSON.parse(readFileSync(join(bundle,'manifest.json'),'utf8')).platform,'darwin');
  console.log(JSON.stringify({kind:'isolated-bundled-observation',...report}));
});
