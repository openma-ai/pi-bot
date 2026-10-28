// Real bundled harness acceptance; no provider credentials or model calls.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync, realpathSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const bundle = process.env.PIBOT_HARNESS_TEST_BUNDLE || fileURLToPath(new URL('../.harness-build/', import.meta.url));
const wait = ms => new Promise(r => setTimeout(r, ms));
function launch(home, boundary = false) {
  for (const path of ['data','pi','workspace','tmp']) mkdirSync(join(home,path), {recursive:true,mode:0o700});
  const report=join(home,'startup-read-boundary.json');
  if(boundary)writeFileSync(report,'[]');
  const preload=fileURLToPath(new URL('./harness-read-boundary.mjs',import.meta.url));
  const child = spawn(join(bundle,'bin/node'), [...(boundary?['--import',preload]:[]),'--import',join(bundle,'node_modules/tsx/dist/loader.mjs'),join(bundle,'launcher.mjs'),'daemon','--data-dir',join(home,'data'),'--pi-dir',join(home,'pi'),'--listen','http://127.0.0.1:0','--drain-timeout','3000','--approval-required'], {
    cwd:join(home,'workspace'),env:{HOME:home,USERPROFILE:home,TMPDIR:join(home,'tmp'),PATH:join(bundle,'bin')+':/usr/bin:/bin',NODE_ENV:'production',LANG:'en_US.UTF-8',TSX_TSCONFIG_PATH:join(bundle,'tsconfig.json'),...(boundary?{PIBOT_TEST_ALLOWED_ROOTS:JSON.stringify([bundle,realpathSync(bundle),home,realpathSync(home),fileURLToPath(new URL('.',import.meta.url))]),PIBOT_TEST_BOUNDARY_REPORT:report}:{})},stdio:['pipe','ignore','pipe']
  });
  let error = '';
  child.stderr.on('data', data => {error += data;});
  return {child, home, get error(){return error;}};
}
async function ready(run) {
  for (let i=0;i<200;i++) {
    if(run.child.exitCode!==null) throw Error('Bundled harness exited before ready: '+run.error);
    const path=join(run.home,'data/daemon.json');
    if(existsSync(path)) {
      const discovery=JSON.parse(readFileSync(path,'utf8'));
      if(discovery.pid===run.child.pid) {
        const response=await fetch(new URL('/readyz',discovery.http)).catch(()=>null);
        if(response?.ok) return discovery;
      }
    }
    await wait(100);
  }
  throw Error('Bundled harness startup timed out: '+run.error);
}
async function exited(run) {
  for(let i=0;i<200;i++) {
    if(run.child.exitCode!==null||run.child.signalCode!==null) return;
    await wait(50);
  }
  throw Error('Owned harness did not exit');
}
async function rpc(home, discovery, method, params={}) {
  // Only this test's generated transport credential; it is never logged/exported.
  const token=readFileSync(join(home,'data/daemon.token'),'utf8').trim();
  const response=await fetch(new URL('/rpc',discovery.http),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...(discovery.connectionId?{'X-PiBot-Connection':discovery.connectionId}:{})},body:JSON.stringify({jsonrpc:'2.0',...(method==='initialized'?{}:{id:1}),method,params})});
  if(response.status===204) return {};
  const result=await response.json();
  if(method==='initialize') discovery.connectionId=result.result?.connectionId;
  return result;
}
test('bundled live harness: ready, isolated configuration, exclusive lease, restart, crash recovery and parent-pipe cleanup', {timeout:90000}, async t=> {
  assert.ok(existsSync(join(bundle,'manifest.json')), 'Run npm run prepare:harness first');
  const home=mkdtempSync(join(tmpdir(),'pibo-builtin-test-'));
  const runs=[];
  const start=(location,boundary=false)=>{const run=launch(location,boundary);runs.push(run);return run;};
  t.after(async()=>{for(const run of runs){run.child.stdin?.end();if(run.child.exitCode===null&&run.child.signalCode===null){await exited(run).catch(()=>{run.child.kill();});}}});
  const first=start(home,true);
  const discovery=await ready(first);
  assert.equal(discovery.agentDir,join(home,'pi'));
  assert.equal(new URL(discovery.http).hostname,'127.0.0.1');
  await rpc(home,discovery,'initialize',{clientInfo:{name:'bundled-harness-test',version:'1'},protocolVersion:'2026-10-13'});
  await rpc(home,discovery,'initialized');
  const status=await rpc(home,discovery,'daemon/status');
  assert.ok(status.result,'Real daemon/status must succeed');
  assert.equal(status.result.model?.setupRequired,true,'Fresh harness must require model setup');
  assert.notEqual(status.result.model.id,'test');
  const created=await rpc(home,discovery,'bot/create',{name:'Isolated harness test',key:'test_missing_model'});
  assert.ok(created.result?.bot?.id);
  const message=await rpc(home,discovery,'turn/start',{botId:created.result.bot.id,text:'Do not call a model',key:'missing-model-test'});
  assert.equal(message.error?.data?.reason,'setupRequired');
  assert.deepEqual(JSON.parse(readFileSync(join(home,'startup-read-boundary.json'),'utf8')),[],'Startup must not search the host Documents/project outside its resource/data roots');
  const duplicate=start(home);
  await exited(duplicate);
  assert.notEqual(duplicate.child.exitCode,0);
  assert.ok((await fetch(new URL('/readyz',discovery.http))).ok,'Duplicate start must not kill its owner');
  // A separate app-owned test runtime represents an unrelated daemon.
  const otherHome=mkdtempSync(join(tmpdir(),'pibo-builtin-independent-'));
  const other=start(otherHome),otherDiscovery=await ready(other);
  first.child.stdin.end(); // exact native shutdown/parent-death protocol
  await exited(first);
  assert.equal(first.child.exitCode,0);
  assert.equal(existsSync(join(home,'data/daemon.json')),false);
  assert.equal(existsSync(join(home,'data/desktop-owner.json')),false);
  assert.ok((await fetch(new URL('/readyz',otherDiscovery.http))).ok);
  const restarted=start(home),restartedDiscovery=await ready(restarted);
  assert.notEqual(restartedDiscovery.pid,discovery.pid);
  restarted.child.kill('SIGKILL');
  await exited(restarted);
  assert.equal(existsSync(join(home,'data/desktop-owner.json')),true);
  const recovered=start(home);
  await ready(recovered);
  recovered.child.stdin.end();
  await exited(recovered);
  assert.equal(recovered.child.exitCode,0);
  other.child.stdin.end();
  await exited(other);
});
