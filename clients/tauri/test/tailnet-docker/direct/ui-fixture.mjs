// Explicit synthetic UI/lease fixture; run only in the isolated test container.
// Host must stop the independent simulator App on READY_TO_RESTART.
import fs from 'node:fs';
import http from 'node:http';
const mode=process.argv[2], bot=process.argv[3];
const config=JSON.parse(fs.readFileSync('/data/control.json','utf8'));
function request(url,token,body){return new Promise((resolve,reject)=>{const r=http.request(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'}},s=>{let b='';s.on('data',x=>b+=x);s.on('end',()=>s.statusCode===200?resolve(JSON.parse(b)):reject(Error('HTTP '+s.statusCode)));});r.on('error',reject);r.end(JSON.stringify(body));});}
const broker=(path,v)=>request(config.url+path,config.token,v);
if(mode==='prepare'){
 await broker('/control',{botId:bot,take:false});
 await broker('/call',{botId:bot,kind:'browser',args:{action:'navigate',url:config.url+'/fixture?bot='+bot}});
 const r=await broker('/call',{botId:bot,kind:'browser',args:{action:'evaluate',expression:`document.body.innerHTML='<textarea id="value" autofocus style="position:fixed;inset:0;width:100%;height:100%;font-size:80px" placeholder="Pibo synthetic keyboard"></textarea>';document.querySelector('#value').focus();'ready'`}});
 if(r.isError)throw Error('Fixture evaluation rejected'); console.log('synthetic input fixture ready');
}
if(mode==='read'){
 const state=await (await fetch(config.url+'/state',{headers:{authorization:'Bearer '+config.token}})).json();
 const r=await broker('/call',{botId:bot,kind:'browser',args:{action:'evaluate',expression:"JSON.stringify({value:document.querySelector('#value')?.value,focused:document.activeElement?.id})"}});
 console.log(JSON.stringify({control:state.control,evaluation:r}));
}
if(mode==='release'){console.log(JSON.stringify(await broker('/control',{botId:bot,take:false})));}
if(mode==='lease'){
 const {WebSocket}=await import('/app/node_modules/ws/wrapper.mjs');
 await broker('/control',{botId:bot,take:true});
 const other='lease-other-synthetic';await broker('/bind',{botId:other});
 const view=new WebSocket(config.url.replace('http:','ws:')+'/ws/'+other,{headers:{authorization:'Bearer '+config.token}});
 await new Promise((ok,no)=>{view.once('open',ok);view.once('error',no)});
 const denied=await new Promise(resolve=>{const s=new WebSocket(config.url.replace('http:','ws:')+'/ws/'+bot,{headers:{authorization:'Bearer '+config.token}});s.once('open',()=>{s.close();resolve(false)});s.once('error',()=>resolve(true));});
 let foreignDenied=false;try{await broker('/control',{botId:other,take:true});}catch{foreignDenied=true;}
 const state=async()=>await(await fetch(config.url+'/state',{headers:{authorization:'Bearer '+config.token}})).json();
 const before=(await state()).control;
 if(!denied||!foreignDenied||before?.botId!==bot)throw Error('Exclusive takeover precondition failed');
 console.log(JSON.stringify({stage:'READY_TO_RESTART',duplicateViewerDenied:denied,foreignTakeoverDenied:foreignDenied,activeBot:before?.botId}));
 let disconnected=false;for(let i=0;i<350;i++){await new Promise(r=>setTimeout(r,100));if(!(await state()).control){disconnected=true;break;}}
 if(!disconnected)throw Error('Controller socket close did not release lease');
 await broker('/control',{botId:other,take:true});await broker('/control',{botId:other,take:false});
 const released=!(await state()).control;
 await broker('/control',{botId:other,take:true});
 console.log(JSON.stringify({stage:'WAITING_EXPIRY',disconnectReleased:disconnected,newControllerAcquired:true,explicitRelease:released}));
 await new Promise(r=>setTimeout(r,61500));
 const expired=!(await state()).control;
 if(!expired)throw Error('Control lease did not expire');
 const resumed=await broker('/call',{botId:bot,kind:'browser',args:{action:'evaluate',expression:"document.querySelector('#value')?.value"}});
 console.log(JSON.stringify({stage:'DONE',duplicateViewerDenied:denied,foreignTakeoverDenied:foreignDenied,disconnectReleased:disconnected,explicitRelease:released,expired,agentResumed:!resumed.isError}));
 view.close();
 if(resumed.isError)throw Error('Agent did not resume after expiry');
}
