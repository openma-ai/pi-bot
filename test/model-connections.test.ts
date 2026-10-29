import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ModelConnections, normalizeEndpoint, createConnectionRuntime } from '../src/pi/model-connections.ts';
import { PiSettings } from '../src/daemon/pi-settings.ts';
import { loadPiConfiguration } from '../src/pi/config.ts';

const endpoint = (baseUrl = 'http://127.0.0.1:45678/v1/') => ({baseUrl,api:'openai-completions',models:[{id:'same-model',name:'Fixture',contextWindow:32000,maxTokens:4096,reasoning:false,input:['text']}]});
function directory() { return mkdtempSync(join(tmpdir(),'pibo-model-connections-fixture-')); }
class MemoryCredentials {
    async read() { return undefined; }
    async list() { return []; }
    async modify(_id: string, fn: any) { return fn(undefined); }
    async delete() {}
}
async function service(dir: string) {
    const models=await ModelRuntime.create({credentials:new MemoryCredentials(),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
    models.registerProvider('fixture-root',{baseUrl:'http://127.0.0.1:45678/v1',api:'openai-completions',models:[{id:'unused',name:'Fixture',reasoning:false,input:['text'],contextWindow:32000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
    // Never enumerate/resolve ambient cloud auth in tests; all legacy state is synthetic.
    const isolated=new Proxy(models,{get(target,key){
        if(key==='getProviders')return()=>[target.getProvider('fixture-root')!];
        if(key==='refresh')return(options:any)=>target.refresh({...options,providers:['fixture-root'],allowNetwork:false});
        if(key==='getAvailable')return(_provider:any,options:any)=>target.getAvailable('fixture-root',options);
        const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    return new (PiSettings as any)(dir,dir,isolated,false) as PiSettings;
}
async function login(settings: PiSettings, id: string, key: string) {
    const result=settings.startLogin('custom','api_key',randomUUID(),id);
    let flow:any;
    for(let i=0;i<200;i++){flow=settings.loginState(result.id);if(flow.prompt)break;await new Promise(r=>setTimeout(r,2));}
    assert.equal(flow.connectionId,id);assert.equal(flow.prompt?.type,'secret');
    settings.answer(result.id,flow.prompt.id,key);
    for(let i=0;i<200;i++){flow=settings.loginState(result.id);if(flow.status!=='pending')break;await new Promise(r=>setTimeout(r,2));}
    assert.equal(flow.status,'complete');
}

test('custom endpoints normalize paths and reject secrets, traversal, query and invalid SDK specs',()=>{
    assert.equal(normalizeEndpoint(endpoint()).baseUrl,'http://127.0.0.1:45678/v1');
    assert.equal(normalizeEndpoint(endpoint('https://example.invalid/team/v1/')).baseUrl,'https://example.invalid/team/v1');
    for(const value of ['file:///tmp/a','https://secret@example.invalid/v1','https://example.invalid/v1?q=key','https://example.invalid/v1#key','https://example.invalid/a/../v1','https://example.invalid/a%2fb','https://example.invalid/v1//','https:\\example.invalid']) assert.throws(()=>normalizeEndpoint(endpoint(value)));
    assert.throws(()=>normalizeEndpoint({...endpoint(),api:'arbitrary-code'}));
    assert.throws(()=>normalizeEndpoint({...endpoint(),headers:{Authorization:'fixture'}}));
    assert.throws(()=>normalizeEndpoint({...endpoint(),models:[{id:'x',contextWindow:1000,maxTokens:2000}]}));
});

test('metadata writes are idempotent and revisions prevent stale updates without credential copying',()=>{
    const dir=directory(),store=new ModelConnections(dir),id=randomUUID();
    const input={id,providerId:'custom',name:'One',endpoint:endpoint()};
    const first=store.save(input);assert.deepEqual(store.save(input),first);
    assert.throws(()=>store.save({...input,name:'Other'}),/reload/);
    const second=store.save({...input,name:'Renamed',expectedRevision:1});assert.equal(second.credentialVersion,1);
    const changed=store.save({...input,name:'Renamed',endpoint:endpoint('https://other.invalid/v1'),expectedRevision:2});assert.equal(changed.credentialVersion,2);
    assert.notEqual(store.directory(changed),store.directory(first));
    assert.equal(existsSync(join(dir,'auth.json')),false);
    assert.throws(()=>store.remove(id,1),/reload/);store.remove(id,3);assert.equal(store.get(id),undefined);
});

test('v0 metadata upgrade is repeatable and ignores interrupted temporary files without opening auth',()=>{
    const dir=directory(),id=randomUUID();
    const old={version:0,connections:[{id,providerId:'custom',name:'Old',endpoint:endpoint()}]};
    writeFileSync(join(dir,'model-connections.json'),JSON.stringify(old));
    writeFileSync(join(dir,'auth.json'),'DO NOT READ OR COPY: fixture sentinel');
    writeFileSync(join(dir,'model-connections.json.interrupted.tmp'),'incomplete');
    const store=new ModelConnections(dir);assert.deepEqual(store.read(),store.read());
    assert.equal(JSON.parse(readFileSync(store.path,'utf8')).version,0);
    store.save({id,providerId:'custom',name:'Migrated metadata',endpoint:endpoint(),expectedRevision:1});
    assert.equal(JSON.parse(readFileSync(store.path,'utf8')).version,1);
    assert.equal(readFileSync(join(dir,'auth.json'),'utf8'),'DO NOT READ OR COPY: fixture sentinel');
    assert.equal(new ModelConnections(dir).get(id)?.credentialVersion,1);
});

test('same-provider/same-model accounts stay isolated across login, catalog refresh, selection, logout and restart',{timeout:120000},async()=>{
    const dir=directory(),settings=await service(dir),store=new ModelConnections(dir);
    const a=(await settings.saveConnection({id:randomUUID(),providerId:'custom',name:'A',endpoint:endpoint()})).connection;
    const b=(await settings.saveConnection({id:randomUUID(),providerId:'custom',name:'B',endpoint:endpoint()})).connection;
    try{
        await login(settings,a.id,'fixture-only-A');await login(settings,b.id,'fixture-only-B');
        const [one,two]=await Promise.all([settings.state(),settings.state()]);
        assert.equal(one.connections.filter((c:any)=>c.providerId==='custom'&&c.configured).length,2);
        assert.deepEqual(one.connections.map((c:any)=>[c.id,c.models.map((m:any)=>m.id)]),two.connections.map((c:any)=>[c.id,c.models.map((m:any)=>m.id)]));
        assert.ok(!JSON.stringify(one).includes('fixture-only-'));
        await settings.selectModel('custom','same-model','off',a.id);
        const running=await loadPiConfiguration({agentDir:dir,cwd:dir});
        assert.equal(running.public.connectionId,a.id);
        assert.throws(()=>settings.startLogin('custom','api_key'),/Explicit model connection/);
        await assert.rejects(settings.logout('custom'),/Explicit model connection/);
        await assert.rejects(settings.selectModel('custom','same-model','off'),/Explicit model connection/);
        assert.equal((await running.models.getAuth(running.model))?.auth.apiKey,'fixture-only-A');
        await settings.selectModel('custom','same-model','off',b.id);
        assert.equal((await running.models.getAuth(running.model))?.auth.apiKey,'fixture-only-A','existing request runtime keeps its captured account');
        const restarted=await loadPiConfiguration({agentDir:dir,cwd:dir});
        assert.equal(restarted.public.connectionId,b.id);assert.equal((await restarted.models.getAuth(restarted.model))?.auth.apiKey,'fixture-only-B');
        await settings.logout('custom',a.id);
        assert.equal(await running.models.getAuth(running.model),undefined);
        assert.equal((await restarted.models.getAuth(restarted.model))?.auth.apiKey,'fixture-only-B');
        assert.throws(()=>restarted.models.streamSimple({...restarted.model,provider:'openai'}, {messages:[]}),/different connection/);
        settings.removeConnection(b.id,1);
        await assert.rejects(loadPiConfiguration({agentDir:dir,cwd:dir}),/所选模型连接不可用/);
        assert.equal(store.read().current?.connectionId,b.id,'removed current selection cannot fall back to another account');
    }finally{settings.close();}
});

test('endpoint replacement starts unauthenticated and cancels only the old connection login',{timeout:120000},async()=>{
    const dir=directory(),settings=await service(dir),store=new ModelConnections(dir),id=randomUUID();
    try{
        const a=(await settings.saveConnection({id,providerId:'custom',name:'A',endpoint:endpoint()})).connection;
        await login(settings,id,'fixture-old-origin');
        const old=await createConnectionRuntime(store,a);
        const changed=await settings.saveConnection({id,providerId:'custom',name:'A',endpoint:endpoint('http://127.0.0.1:45679/new/v1'),expectedRevision:1});
        assert.equal(changed.requiresAuthentication,true);
        const fresh=await createConnectionRuntime(store,changed.connection);
        assert.equal(await fresh.getAuth('custom'),undefined);assert.deepEqual(await fresh.getAvailable(),[]);
        assert.equal((await old.getAuth('custom'))?.auth.apiKey,'fixture-old-origin');
        assert.equal(old.getModel('custom','same-model')?.baseUrl,'http://127.0.0.1:45678/v1');
        assert.equal(fresh.getModel('custom','same-model')?.baseUrl,'http://127.0.0.1:45679/new/v1');
        const other=(await settings.saveConnection({id:randomUUID(),providerId:'custom',name:'Other',endpoint:endpoint()})).connection;
        const otherFlow=settings.startLogin('custom','api_key',randomUUID(),other.id);
        const flow=settings.startLogin('custom','api_key',randomUUID(),id);
        await settings.saveConnection({id,providerId:'custom',name:'A',endpoint:endpoint('http://127.0.0.1:45679/final/v1'),expectedRevision:2});
        await new Promise(r=>setTimeout(r,20));assert.equal(settings.loginState(flow.id).status,'cancelled');
        assert.equal(settings.loginState(otherFlow.id).status,'pending','replacement must not cancel a sibling account');
        assert.throws(()=>settings.answer(flow.id,'late-prompt','fixture-late'),/失效/);
        settings.removeConnection(other.id,1);assert.equal(settings.loginState(otherFlow.id).status,'cancelled');
        assert.equal(await fresh.getAuth('custom'),undefined);
    }finally{settings.close();}
});


test('SDK request routes same-name models to their captured endpoint and never ambient keys',{timeout:120000},async()=>{
    const dir=directory(),settings=await service(dir),store=new ModelConnections(dir);
    try{
        const a=(await settings.saveConnection({id:randomUUID(),providerId:'custom',name:'A',endpoint:endpoint('http://127.0.0.1:45678/team-a/v1/')})).connection;
        const b=(await settings.saveConnection({id:randomUUID(),providerId:'custom',name:'B',endpoint:endpoint('http://127.0.0.1:45679/team-b/v1/')})).connection;
        await login(settings,a.id,'fixture-wire-A');await login(settings,b.id,'fixture-wire-B');
        const runtimes=await Promise.all([a,b].map(c=>createConnectionRuntime(store,c)));
        const requests:{url:string;auth:string|null;model:string}[]=[];
        let release!:()=>void,started!:()=>void;
        const hold=new Promise<void>(r=>release=r),inFlight=new Promise<void>(r=>started=r);
        const fetchMock: typeof fetch=async(input,init)=>{
            requests.push({url:String(input),auth:new Headers(init?.headers).get('authorization'),model:JSON.parse(String(init?.body)).model});
            if(String(input).includes('team-a')){started();await hold;}
            const chunk={id:'fixture',object:'chat.completion.chunk',created:0,model:'same-model',choices:[{index:0,delta:{role:'assistant',content:'fixture'},finish_reason:'stop'}]};
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
        };
        const pending=Promise.all(runtimes.map(r=>r.completeSimple(r.getModel('custom','same-model')!,{messages:[{role:'user',content:'fixture',timestamp:0}]},{maxRetries:0,fetch:fetchMock})));
        await inFlight;
        const replacement=store.save({id:a.id,providerId:'custom',name:'A',endpoint:endpoint('http://127.0.0.1:45680/replaced/v1'),expectedRevision:1});
        release();
        const replies=await pending;
        assert.equal(await (await createConnectionRuntime(store,replacement)).getAuth('custom'),undefined);
        assert.ok(replies.every(r=>r.stopReason==='stop'));
        assert.deepEqual(requests.sort((a,b)=>a.url.localeCompare(b.url)),[
            {url:'http://127.0.0.1:45678/team-a/v1/chat/completions',auth:'Bearer fixture-wire-A',model:'same-model'},
            {url:'http://127.0.0.1:45679/team-b/v1/chat/completions',auth:'Bearer fixture-wire-B',model:'same-model'}]);
        assert.throws(()=>runtimes[0].streamSimple({...runtimes[0].getModel('custom','same-model')!,baseUrl:'https://other.invalid/v1'},{messages:[]}),/different connection/);
        const empty=store.save({id:randomUUID(),providerId:'openai',name:'Unconfigured'});
        const runtime=await createConnectionRuntime(store,empty),model=runtime.getModels()[0];
        let fetches=0;
        const reply=await runtime.completeSimple(model,{messages:[{role:'user',content:'fixture',timestamp:0}]},{maxRetries:0,fetch:async()=>{fetches++;throw Error('must not reach transport');},env:{OPENAI_API_KEY:'fixture-ambient-denied'}});
        assert.equal(reply.stopReason,'error');assert.equal(fetches,0);
    }finally{settings.close();}
});

test('official credential locks serialize same-account OAuth refresh and isolate sibling accounts',{timeout:120000},async()=>{
    const dir=directory(),store=new ModelConnections(dir);
    const records=['A','B'].map(name=>store.save({id:randomUUID(),providerId:'custom',name,endpoint:endpoint()}));
    const counts=new Map<string,number>();
    const runtimes=await Promise.all(records.map(c=>createConnectionRuntime(store,c)));
    for(let i=0;i<runtimes.length;i++){
        const runtime=runtimes[i],name=records[i].name,base=runtime.getProvider('custom')!;
        runtime.registerNativeProvider({...base,auth:{oauth:{name:'Fixture OAuth',login:async()=>({type:'oauth',access:'fixture-old-'+name,refresh:'fixture-refresh-'+name,expires:0}),refresh:async c=>{counts.set(name,(counts.get(name)??0)+1);await new Promise(r=>setTimeout(r,5));return {...c,access:'fixture-new-'+name,expires:Date.now()+3600000};},toAuth:async c=>({apiKey:c.access})}}});
        await runtime.login('custom','oauth',{prompt:async()=>{throw Error('unexpected prompt');},notify:()=>{}});
    }
    const auth=await Promise.all([runtimes[0].getAuth('custom'),runtimes[0].getAuth('custom'),runtimes[1].getAuth('custom')]);
    assert.equal(counts.get('A'),1);assert.equal(counts.get('B'),1);
    assert.deepEqual(auth.map(a=>a?.auth.apiKey),['fixture-new-A','fixture-new-A','fixture-new-B']);
    await runtimes[0].logout('custom');assert.equal(await runtimes[0].getAuth('custom'),undefined);assert.equal((await runtimes[1].getAuth('custom'))?.auth.apiKey,'fixture-new-B');
});


test('late cancelled SDK login cannot persist into the replaced endpoint or resurrect the flow',{timeout:120000},async()=>{
    const dir=directory(),settings=await service(dir),store=new ModelConnections(dir),id=randomUUID();
    let release!:()=>void;
    try{
        await settings.saveConnection({id,providerId:'custom',name:'Late',endpoint:endpoint()});
        const context=await (settings as any).context('custom',id),runtime=context.models as ModelRuntime,provider=runtime.getProvider('custom')!;
        let started!:()=>void;
        const held=new Promise<void>(r=>release=r),began=new Promise<void>(r=>started=r);
        runtime.registerNativeProvider({...provider,auth:{apiKey:{...provider.auth.apiKey!,login:async()=>{started();await held;return {type:'api_key',key:'fixture-late-cancelled'};}}}});
        const flow=settings.startLogin('custom','api_key',randomUUID(),id);
        await began;
        const changed=await settings.saveConnection({id,providerId:'custom',name:'Late',endpoint:endpoint('http://127.0.0.1:45679/replaced/v1'),expectedRevision:1});
        release();
        await new Promise(r=>setTimeout(r,30));
        assert.equal(settings.loginState(flow.id).status,'cancelled');
        assert.equal(await runtime.getAuth('custom'),undefined,'SDK abort boundary prevents late credential commit');
        const fresh=await createConnectionRuntime(store,changed.connection);
        assert.equal(await fresh.getAuth('custom'),undefined,'new endpoint has a new empty credential generation');
        assert.equal(settings.loginState(flow.id).prompt,undefined);
    }finally{release?.();settings.close();}
});
