import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
test('synthetic server HTTP bytes, restricted routes and WebSocket echo',{timeout:10000},async()=>{
 const child=spawn(process.execPath,[new URL('./server.mjs',import.meta.url).pathname],{env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']});
 try{
  const [line]=await once(child.stdout,'data');const info=JSON.parse(line.toString());const base='http://'+info.listen;
  assert.equal((await (await fetch(base+'/health')).json()).service,'pibo-synthetic-tailnet-test');
  const data=Buffer.from([0,1,2,255,128,0]);assert.deepEqual(Buffer.from(await (await fetch(base+'/echo',{method:'POST',body:data})).arrayBuffer()),data);
  assert.equal((await fetch(base+'/etc/passwd')).status,404);
  const ws=new WebSocket(base.replace('http:','ws:')+'/ws');await once(ws,'open');ws.send('synthetic-pibo-roundtrip');const [message]=await once(ws,'message');assert.equal(message.data,'synthetic-pibo-roundtrip');ws.close();await once(ws,'close');
 }finally{child.kill('SIGTERM');await once(child,'exit');}
});
