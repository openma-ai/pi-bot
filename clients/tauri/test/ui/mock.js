import {configureNativeViewport} from "/src/gui/native-viewport.ts";
const query=new URLSearchParams(location.search);const phone=query.has('phone');
if(phone){Object.defineProperty(navigator,'platform',{get:()=> 'iPhone'});Object.defineProperty(navigator,'maxTouchPoints',{get:()=>5});}
if(query.has('mac')){Object.defineProperty(navigator,'platform',{get:()=> 'MacIntel'});Object.defineProperty(navigator,'maxTouchPoints',{get:()=>0});}
if(phone)configureNativeViewport(document,{userAgent:'iPhone',platform:'iPhone',maxTouchPoints:5});
const profiles=query.has('returning')?[{id:'saved',name:'开发工作空间',mode:'direct',url:'https://synthetic.example.invalid/',dataDir:'',...(query.has('tailnet')?{mode:'tailnet',url:undefined,host:'100.100.1.2',serverPort:4319,embeddedTailscale:true}: {})}]:[];
if(query.has('builtin')&&!phone)profiles.unshift({id:'builtin',name:'本机 · 测试状态',mode:'builtin',dataDir:''});
const state={connectionGeneration:0,profiles,active:null,remoteOnly:phone,credentialStorage:phone?'keychain':'system',connecting:false,embeddedTailscaleAvailable:true,tailscaleNodeState:'notPrepared'};
if(query.has('builtin'))state.builtinHarness={supported:!phone,available:!phone&&!query.has('unavailable'),state:query.has('unavailable')?'unavailable':'stopped',...(query.has('unavailable')?{error:'测试：未找到内置运行组件'}:{})};
if(query.has('restore')){localStorage.setItem('pibo.lastConnection','saved');localStorage.setItem('pibo.lastRuntime',JSON.stringify({id:'saved',name:'演示工作空间',mode:'direct'}));localStorage.setItem('pibo.restoreEnabled','1');}
else {localStorage.removeItem('pibo.lastConnection');localStorage.removeItem('pibo.lastRuntime');localStorage.setItem('pibo.restoreEnabled','0');}
if(query.has('connected'))state.active={id:'mock',profileId:'saved',mode:'direct',baseUrl:'/runtime/mock',scope:'synthetic-qa',label:'演示工作空间',profile:{id:'saved',name:'演示工作空间 · 测试数据',mode:'direct',url:'https://synthetic.example.invalid/',dataDir:''}};
const modelConfig={current:{provider:'demo',model:'pibo-balanced',thinkingLevel:'high'},providers:[{id:'demo',name:'演示提供商（假数据）',credential:'api-key',methods:[],models:[{id:'pibo-balanced',name:'Pibo Balanced · 测试模型'},{id:'pibo-fast',name:'Pibo Fast · 测试模型'}]}]};
window.__PIBO_TEST__=state;state.modelWrites=[];state.botCreates=0;state.connectAttempts=0;state.nativeCalls=[];
window.__PIBOT_NATIVE__={call:async(command,args)=>{if(command==='runtime_control'){state.nativeCalls.push(args.method);
 if(args.method==='tailscale/browserStart'){state.tailBackend='NeedsLogin';state.tailscaleNodeState='prepared';return {started:true};}
 if(args.method==='tailscale/status')return {backendState:state.tailBackend||'NotPrepared',authURL:state.tailBackend==='NeedsLogin'?'https://login.tailscale.com/a/synthetic-ui-only':null,ips:[],peers:state.tailBackend==='Running'?[{name:'合成开发电脑',dnsName:'synthetic.test',ip:'100.100.1.2',online:true},{name:'合成离线电脑',ip:'100.100.1.3',online:false}]:[]};
 if(args.method==='tailscale/openLogin'){state.mockBrowserOpened=true;if(query.has('approve'))state.tailBackend='Running';return {opened:true};}
 if(args.method==='tailscale/probe')return {name:'合成 Pibo 工作空间',pairing:true};
 if(args.method==='tailscale/pair')return {paired:true,deviceId:'synthetic'};
 if(args.method==='tailscale/forgetDevice')return {removed:true};
 if(args.method==='tailscale/closeLogin')return {closed:true};
 if(args.method==='tailscale/logout'){state.tailBackend='NotPrepared';return {loggedOut:true};}
 if(args.method==='tailscale/start'){state.tailscaleNodeState='prepared';return {configured:true};}
 if(args.method==='tailscale/stop'){state.tailBackend='NotPrepared';state.tailscaleNodeState='notPrepared';return {configured:false};}
 }if(command==='ssh_credentials_set')return null;if(command==='runtime_distribution_status')return {available:false};if(command==='layout_diagnostics_enabled')return false;return null;}};
window.__TAURI_INTERNALS__={invoke:async()=>1,transformCallback:()=>1};window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
const original=fetch;window.fetch=async(input,options={})=>{const url=new URL(input,location.href);if(query.has('models')&&url.pathname.startsWith('/runtime/mock/pi/')) {
if(url.pathname.endsWith('/config')) return Response.json(modelConfig);
if(url.pathname.endsWith('/model')){state.modelWrites.push(JSON.parse(options.body));if(query.has('model-error'))return Response.json({error:'测试失败：暂时无法保存，请重试'},{status:400});modelConfig.current={...modelConfig.current,...JSON.parse(options.body)};return Response.json({saved:true});}
return Response.json({error:'QA does not authorize provider authentication'},{status:403});}
if(url.pathname==='/runtime/mock/rpc'&&options.body){const call=JSON.parse(options.body);if(call.method==='turn/start')return Response.json({jsonrpc:'2.0',id:call.id,error:{code:-32603,message:'这是界面演示，未连接模型。请打开 Pibo Development 并在设置中连接真实工作空间。',data:{reason:'internal'}}});if(call.method==='bot/create'){state.botCreates++;if(query.has('create-error'))return Response.json({jsonrpc:'2.0',id:call.id,error:{code:-32603,message:'Synthetic create failure',data:{reason:'internal'}}});}}
if(url.pathname==='/client/rpc'){const f=JSON.parse(options.body);try{
 let result=state;if(f.method==='runtime/configure'){state.profiles=[...state.profiles.filter(p=>p.id!==f.params.profile.id),f.params.profile];}
 if(f.method==='runtime/connect'){state.connectAttempts++;const generation=++state.connectionGeneration;await new Promise(r=>setTimeout(r,query.has('slow')?5000:1500));if(generation!==state.connectionGeneration)throw Error('已取消连接');if(query.has('success')||state.connectSucceeds){state.active={id:'mock',profileId:f.params.profile.id,mode:f.params.profile.mode,baseUrl:'/runtime/mock',scope:f.params.profile.id==='saved'?'synthetic-qa':f.params.profile.id,label:f.params.profile.name,profile:f.params.profile};return Response.json({jsonrpc:'2.0',id:f.id,result:state});}throw Error(query.has('key-error')?'请先授权并准备内嵌节点':'无法连接 runtime，请检查服务是否已独立启动');}
 if(f.method==='runtime/builtinStop'){state.builtinHarness.state='stopped';state.active=null;}
 if(f.method==='runtime/disconnect'){state.connectionGeneration++;state.active=null;}
 return Response.json({jsonrpc:'2.0',id:f.id,result});}catch(e){return Response.json({jsonrpc:'2.0',id:f.id,error:{message:e.message}});}}
 if(query.has('story')&&url.pathname==='/runtime/mock/rpc'&&options.body&&JSON.parse(options.body).method==='daemon/snapshot') {
 const response=await original(input,options),frame=await response.json(),snapshot=frame.result;
 if(state.emptySnapshot){snapshot.bots=[];snapshot.items=[];snapshot.groups=[];snapshot.threads=[];snapshot.turns=[];snapshot.jobs=[];snapshot.requests=[];return Response.json(frame);}
 const bot=snapshot.bots[0];if(bot){bot.name='灵感搭子 · 演示';const texts=['帮我整理一下今天的灵感，做成一个小计划。','可以。先把想法放在这里，我们一起慢慢理清。\n\n1. 收集最想做的三件事\n2. 选出今天能开始的一件\n3. 留一个明天继续的线索','先从新产品的欢迎页面开始。'];
 snapshot.items.push(...texts.map((text,i)=>({id:'visual-demo-'+i,type:i===1?'agentMessage':'inputMessage',threadId:'visual-demo',turnId:null,status:'completed',botId:bot.id,message:{messageId:'visual-demo-'+i,botId:bot.id,sender:i===1?bot.id:'user',sourceKind:i===1?'bot':'user',direction:i===1?'outbound':'inbound',channelId:bot.channelId||'local:'+bot.id,status:i===1?'delivered':'processed',receivedAt:Date.now()-180000+i*60000,text}})));}
 return Response.json(frame);
 }
 return original(input,options);};
await import('/src/gui/main.jsx');
