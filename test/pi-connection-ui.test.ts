import {test} from 'node:test';
import assert from 'node:assert/strict';
import {piConnections,piModelOptions,currentConnectionId,endpointInputError} from '../src/gui/pi-connections.ts';
import {createPiLoginFlow} from '../src/gui/pi-login-flow.ts';
test('same provider and model stay distinct by connection; removed current never falls back',()=>{
 const c={current:{connectionId:'removed',provider:'openai',model:'same'},connections:[{id:'a',providerId:'openai',name:'A',configured:true,models:[{id:'same'}]},{id:'b',providerId:'openai',name:'B',configured:true,models:[{id:'same'}]}]};
 const options=piModelOptions(c);assert.equal(options.length,2);assert.notEqual(options[0].id,options[1].id);assert.equal(currentConnectionId(c),'removed');assert.equal(options.find(m=>m.connectionId==='removed'),undefined);
});
test('legacy projection preserves input and does not invent new credentials',()=>{
 const c={current:{provider:'openai'},providers:[{id:'openai',credential:'oauth',configured:true,models:[]},{id:'other',configured:false}]};const before=structuredClone(c);
 assert.equal(piConnections(c)[0].id,'legacy:openai');assert.equal(piConnections(c).length,1);assert.deepEqual(c,before);
});
test('endpoint form validates paths without altering origins',()=>{
 for(const url of ['https://example.invalid/v1','https://example.invalid/v1/','http://127.0.0.1:4567/v1'])assert.equal(endpointInputError(url),undefined,url);
 for(const url of ['','file:///x','https://u:p@example.invalid','https://example.invalid?key=x','https://example.invalid/#x','https://example.invalid//v1','https://example.invalid/../v1','https://example.invalid/%2e/v1','https://example.invalid\\v1','https://example.invalid/\n'])assert.ok(endpointInputError(url),url);
});
test('login carries exact connection and rejects a same-provider cross-account response',async()=>{
 let id='',state:any;const calls:any[]=[];
 const flow=createPiLoginFlow(async(path,body:any)=>{calls.push({path,body});if(path==='login'){id=body.requestId;return{id};}return{id,providerId:'openai',connectionId:'other',status:'complete',events:[]};},s=>state=s);
 await flow.begin('openai','oauth','a');assert.equal(calls[0].body.connectionId,'a');await flow.poll();assert.equal(state.connectionId,'a');assert.equal(state.status,'pending');assert.equal(state.errorCode,'invalidResponse');await flow.cancel();
});
