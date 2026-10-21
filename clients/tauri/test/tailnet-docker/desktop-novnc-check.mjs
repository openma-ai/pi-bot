// Runs only inside the disposable desktop container. No host listener or proxy.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {WebSocket,WebSocketServer} from '/app/node_modules/ws/wrapper.mjs';
import {Session} from '/app/node_modules/pi-chrome-use/src/cdp/session.ts';
const cdp=new Session();
async function viewEval(expression){const r=await cdp.domains.Runtime.evaluate({expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('Viewer CDP evaluation failed');return r.result.value;}
const config=JSON.parse(readFileSync('/data/control.json','utf8'));
const headers={authorization:`Bearer ${config.token}`,'content-type':'application/json'};
async function call(path,data){const r=await fetch(config.url+path,{headers,...(data?{method:'POST',body:JSON.stringify(data)}:{})});if(!r.ok)throw Error(`Desktop ${path}: ${r.status}`);return r.json();}
const source='tailnet-vnc-source',viewer='tailnet-vnc-viewer';
const browser=(botId,args)=>call('/call',{botId,kind:'browser',args});
async function evaluate(botId,expression){const r=await browser(botId,{action:'evaluate',expression});if(r.isError)throw Error('Owned browser evaluation failed');return JSON.parse(r.details.result).result.value;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assets='/app/node_modules/@novnc/novnc';
const page=`<!doctype html><meta charset="utf-8"><title>Pibo disposable noVNC check</title><style>html,body{margin:0;background:#222}#view{width:100vw;height:90vh}</style><div id="view"></div><script type="module">import RFB from '/novnc/core/rfb.js';window.rfb=new RFB(document.getElementById('view'),'ws://127.0.0.1:6099/ws',{shared:true});rfb.scaleViewport=true;rfb.viewOnly=false;rfb.addEventListener('connect',()=>window.vncConnected=true);rfb.addEventListener('disconnect',e=>window.vncError=String(e.detail.clean));</script>`;
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://127.0.0.1').pathname;
 if(pathname==='/'){res.writeHead(200,{'content-type':'text/html'}).end(page);return;}
 if(!pathname.startsWith('/novnc/'))return res.writeHead(404).end();
 const file=resolve(assets,decodeURIComponent(pathname.slice(7)));
 if(!file.startsWith(assets+'/'))return res.writeHead(403).end();
 try{res.writeHead(200,{'content-type':extname(file)==='.js'?'text/javascript':'application/octet-stream'}).end(readFileSync(file));}catch{res.writeHead(404).end();}
});
const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{
 if(req.url!=='/ws')return socket.destroy();
 wss.handleUpgrade(req,socket,head,web=>{
  const upstream=new WebSocket(config.url.replace('http:','ws:')+'/ws/'+source,{headers:{authorization:headers.authorization}});
  const queue=[];web.on('message',(data,isBinary)=>{if(upstream.readyState===1)upstream.send(data,{binary:isBinary});else queue.push([data,isBinary]);});
  upstream.on('open',()=>{for(const [data,binary]of queue)upstream.send(data,{binary});});
  upstream.on('message',(data,isBinary)=>{if(web.readyState===1)web.send(data,{binary:isBinary});});
  upstream.on('error',()=>web.close());web.on('error',()=>upstream.close());web.on('close',()=>upstream.close());upstream.on('close',()=>web.close());
 });
});
const report={platform:'Chromium inside disposable Linux desktop container',path:'real noVNC browser canvas -> container-loopback WebSocket auth relay -> existing desktop-service -> x11vnc/Xvfb',tailnetVerified:false,hostPortPublished:false,cases:{}};
try{
 await new Promise((ok,no)=>server.listen(6099,'127.0.0.1',ok).once('error',no));
 await call('/bind',{botId:source});const binding=await call('/bind',{botId:viewer});
 await cdp.connect({wsUrl:(await (await fetch('http://127.0.0.1:9222/json/version')).json()).webSocketDebuggerUrl});await cdp.use(binding.targetId);
 await browser(source,{action:'navigate',url:config.url+'/fixture?bot='+source});
 await evaluate(source,"document.querySelector('#value').value='';document.querySelector('#value').focus();'ready'");
 await browser(viewer,{action:'navigate',url:'http://127.0.0.1:6099/'});
 let ready=false;for(let i=0;i<40;i++){if(await viewEval('Boolean(window.vncConnected)')){ready=true;break;}await sleep(250);}assert.ok(ready,'noVNC connected');
 await sleep(700);report.cases.realNoVNCConnected=true;
 await call('/control',{botId:source,take:true});
 await viewEval("for(const ch of 'RFB-KEYBOARD')window.rfb.sendKey(ch.charCodeAt(0),'Unidentified');true");
 await sleep(400);await call('/control',{botId:source,take:false});assert.equal(await evaluate(source,"document.querySelector('#value').value"),'RFB-KEYBOARD');report.cases.noVNCKeyboard=true;
 const coords=await evaluate(source,"(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2+outerHeight-innerHeight}})()");
 await call('/control',{botId:source,take:true});
 await viewEval(`(()=>{const c=document.querySelector('canvas'),r=c.getBoundingClientRect();const x=r.left+${coords.x}*r.width/c.width,y=r.top+${coords.y}*r.height/c.height;c.dispatchEvent(new MouseEvent('mousedown',{clientX:x,clientY:y,button:0,buttons:1,bubbles:true}));c.dispatchEvent(new MouseEvent('mouseup',{clientX:x,clientY:y,button:0,buttons:0,bubbles:true}));return true})()`);
 await sleep(400);await call('/control',{botId:source,take:false});assert.equal(await evaluate(source,"document.querySelector('#result').textContent"),'RFB-KEYBOARD');report.cases.noVNCMouse=true;
 const frame=await viewEval("document.querySelector('canvas').toDataURL('image/png')");const bytes=Buffer.from(frame.split(',')[1],'base64');assert.ok(bytes.length>10000);assert.equal(bytes.subarray(1,4).toString(),'PNG');
 mkdirSync('/data/evidence',{recursive:true});writeFileSync('/data/evidence/novnc-canvas.png',bytes);report.cases.actualFramePixels=true;report.pngSha256=createHash('sha256').update(bytes).digest('hex');report.pngBytes=bytes.length;report.ok=true;
}catch(error){report.ok=false;report.error=String(error);}finally{
 await call('/control',{botId:source,take:false}).catch(()=>{});await viewEval('window.rfb?.disconnect();true').catch(()=>{});
 mkdirSync('/data/evidence',{recursive:true});writeFileSync('/data/evidence/novnc-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));await cdp.close();wss.close();server.close();
}
process.exit(report.ok?0:1);
