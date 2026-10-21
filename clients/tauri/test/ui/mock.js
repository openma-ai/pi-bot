const query=new URLSearchParams(location.search);const phone=query.has('phone');
if(phone){Object.defineProperty(navigator,'platform',{get:()=> 'iPhone'});Object.defineProperty(navigator,'maxTouchPoints',{get:()=>5});}
const profiles=query.has('returning')?[{id:'saved',name:'开发工作空间',mode:'ssh',host:'me@dev.example',dataDir:'/srv/pibo/data',projectDir:'/srv/pibo',serverPort:0,...(query.has('tailnet')?{embeddedTailscale:true}: {})}]:[];
const state={profiles,active:null,remoteOnly:phone,credentialStorage:phone?'keychain':'system',connecting:false,embeddedTailscaleAvailable:true,tailscaleNodeState:'notPrepared'};
window.__PIBOT_NATIVE__={call:async(command,args)=>{if(command==='runtime_control'){if(args.method==='tailscale/start'){state.tailscaleNodeState='prepared';return {configured:true};}if(args.method==='tailscale/stop'){state.tailscaleNodeState='notPrepared';return {configured:false};}}if(command==='ssh_credentials_set')return null;if(command==='runtime_distribution_status')return {available:false};if(command==='layout_diagnostics_enabled')return false;return null;}};
window.__TAURI_INTERNALS__={invoke:async()=>1,transformCallback:()=>1};window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
const original=fetch;window.fetch=async(input,options={})=>{const url=new URL(input,location.href);if(url.pathname==='/client/rpc'){const f=JSON.parse(options.body);try{
 let result=state;if(f.method==='runtime/configure'){state.profiles=[...state.profiles.filter(p=>p.id!==f.params.profile.id),f.params.profile];}
 if(f.method==='runtime/connect'){await new Promise(r=>setTimeout(r,1500));if(query.has('success')){state.active={id:'mock',profileId:f.params.profile.id,mode:f.params.profile.mode,baseUrl:'/runtime/mock',scope:f.params.profile.id,label:f.params.profile.name,profile:f.params.profile};return Response.json({jsonrpc:'2.0',id:f.id,result:state});}throw Error(query.has('key-error')?'请先授权并准备内嵌节点':'无法连接 runtime，请检查服务是否已独立启动');}
 if(f.method==='runtime/disconnect')state.active=null;
 return Response.json({jsonrpc:'2.0',id:f.id,result});}catch(e){return Response.json({jsonrpc:'2.0',id:f.id,error:{message:e.message}});}}
 return original(input,options);};
await import('/src/gui/main.jsx');
