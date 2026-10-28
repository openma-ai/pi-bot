import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Theme,Button} from '@radix-ui/themes';
import '@radix-ui/themes/styles.css';
import '/src/gui/style.css';
import '/src/gui/components.css';
import '/src/gui/brand.css';
import {SettingsPage} from '/src/gui/SettingsPage.jsx';

// UI fixture only: no daemon, provider, OAuth grant, real credentials or native bridge.
const parameters = new URLSearchParams(location.search);
// Synthetic models deliberately support this small fixture-only set. Production
// choices come from the runtime SDK, never from this QA definition.
const fakeThinkingLevels = ['off','low','medium','high'];
const providers = [
  {id:'openai',name:'OpenAI',methods:['api_key','oauth'],methodLabels:{api_key:'OpenAI API key',oauth:'Sign in with ChatGPT'},credential:null,configured:false,catalog:{status:"cached"},models:[{id:'qa-model',name:'QA fixture model',reasoning:true,thinkingLevels:fakeThinkingLevels},{id:'qa-fast',name:'QA fixture fast',reasoning:false,thinkingLevels:['off']}]},
  {id:'openai-codex',name:'OpenAI Codex (legacy)',methods:['oauth'],methodLabels:{oauth:'OpenAI (ChatGPT Plus/Pro)'},credential:null,configured:false,catalog:{status:"cached"},models:[{id:'qa-codex',name:'QA fixture Codex',reasoning:true,thinkingLevels:fakeThinkingLevels}]},
  {id:'deepseek',name:'DeepSeek',methods:['api_key'],methodLabels:{api_key:'DeepSeek API key'},credential:null,configured:false,catalog:{status:"cached"},models:[{id:'qa-deepseek',name:'QA fixture DeepSeek',reasoning:true,thinkingLevels:fakeThinkingLevels}]},
];
if(parameters.get('effort')==='gpt-6-sol')providers[0].models[0]={id:'gpt-6-sol',name:'GPT-6 Sol · 隔离 QA',reasoning:true,
  // Checked against the bundled Pi 1.2.0 specification; no account or inference call.
  thinkingLevels:['off','low','medium','high','xhigh','max']};
let config = {current:{provider:'',model:'',thinkingLevel:'high'},providers,catalog:{status:parameters.get('catalog')||'cached',source:'isolated-sdk-fixture'},reloadPending:false};
providers.forEach(provider=>{provider.catalog={...config.catalog};});
if(parameters.has('configured')||parameters.has('ambient')){providers[0].configured=true;if(!parameters.has('ambient'))providers[0].credential='oauth';if(parameters.has('configured'))config.current={provider:'openai',model:providers[0].models[0].id,thinkingLevel:parameters.get('thinking')||'high'};}
// Account catalog states are synthetic. Never query a real account or provider.
function accountCatalog(provider,state='confirmed'){
  provider.catalog={source:'openai-account',status:state==='failed'?'failed':state==='partial'?'partial':'refreshed',accountAccess:state==='failed'?'unverified':'confirmed',authChecked:state!=='failed',unsupportedModelCount:state==='partial'?1:0,...(state==='partial'?{unsupportedModelReason:'隔离 QA：未知 SDK 型号已过滤'}:{})};
  if(state==='failed'){provider.models=[];provider.configured=false;}
}
if(parameters.has('account')){providers[0].credential='oauth';providers[0].configured=true;accountCatalog(providers[0],parameters.get('account'));}
const flows = new Map(), calls = [], nativeForms = new Map();
const fakeAuthUrl='https://example.invalid/isolated-qa-no-oauth';
const browserEvents=()=>[{type:'auth_url',url:fakeAuthUrl,instructions:'隔离 QA：此链接不会执行真实授权'}];
const lastId=()=>[...flows.keys()].at(-1);
const warnings=[],warn=console.warn.bind(console);
console.warn=(...args)=>{warnings.push(args.filter(v=>typeof v==='string').join(' '));warn(...args);};
let mode = parameters.get('mode') || '', releaseStart, releaseAnswer, releaseState, holdState=false;
const freshFlow = (id,provider,type) => ({id,providerId:provider,type,status:'pending',events:type==='oauth'&&provider==='openai'?browserEvents():[],expiresAt:Date.now()+900000,
  prompt:type === 'api_key' ? {id:id+'-key',type:'secret',message:'隔离 QA：仅可输入假密钥'} : provider === 'openai-codex' ?
  {id:id+'-method',type:'select',message:'Select OpenAI Codex login method:',options:[{id:'browser',label:'Browser login (default)'},{id:'device_code',label:'Device code login (headless)'}]} :
  {id:id+'-manual',type:'manual_code',message:'隔离 QA：粘贴假回跳地址，不会发起真实授权'}});
const json = (value,status=200) => Response.json(structuredClone(value),{status});
window.__MODEL_AUTH_QA__ = {calls,flows,nativeForms,warnings,configuration(){return structuredClone(config);},setMode(value){mode=value;},releaseStart(){releaseStart?.();},releaseAnswer(){releaseAnswer?.();},releaseState(){holdState=false;releaseState?.();},
  progress(id=lastId()){const flow=flows.get(id);if(flow){flow.events=[...browserEvents(),{type:'progress',message:'隔离 QA：正在确认授权结果'}];}},
  fail(id=lastId()){const flow=flows.get(id);if(flow){flow.status='failed';flow.error='隔离 QA：授权未完成';delete flow.prompt;}},
  complete(id=lastId(),persist=true){const flow=flows.get(id);if(flow){flow.status='complete';delete flow.prompt;if(persist){const provider=providers.find(p=>p.id===flow.providerId);provider.credential=flow.type;provider.configured=true;config.catalog={status:'refreshed',source:'isolated-sdk-fixture'};provider.catalog={...config.catalog};if(provider.id==='openai'&&flow.type==='oauth')accountCatalog(provider,parameters.get('account')||'confirmed');}}}};
if(parameters.has('native')) window.__PIBOT_NATIVE__ = {call:async(command,args={})=>{
  const id=args.path?.split('/').at(-1),flow=flows.get(id);
  calls.push({kind:'native-mock',command,path:args.path,promptId:args.promptId});
  if(command==='pi_settings_credential_window'){
    if(flow?.status!=='pending'||flow.prompt?.id!==args.promptId)throw {code:'promptExpired',message:'隔离 QA：步骤失效'};
    nativeForms.set(id,args.promptId);return;
  }
  if(command==='pi_settings_close_forms'){
    if(flow&&flow.status!=='pending'){return nativeForms.delete(id)?1:0;}return 0;
  }
  if(command==='pi_settings_open_login'){
    if(flow?.status!=='pending'||args.url!==fakeAuthUrl)throw {code:'nativePolicyDenied',message:'隔离 QA：仅可使用假授权链接'};
    return;
  }
  throw {code:'nativePolicyDenied',message:'隔离 QA：未实现的原生命令'};
}};
// Browser clicks remain local too. No fixture link can navigate to a provider.
document.addEventListener('click',event=>{const link=event.target.closest?.('a[href]');if(link&&new URL(link.href).origin!==location.origin){event.preventDefault();calls.push({kind:'blocked-fixture-link'});}},true);
window.fetch = async (input,options={}) => {
  const url = new URL(typeof input==='string'?input:input.url, location.href), method=options.method||'GET';
  if(url.origin!==location.origin || !url.pathname.startsWith('/qa/pi/')) throw new Error('QA fixture blocked external or unmocked request');
  const path=url.pathname.slice('/qa/pi/'.length), body=options.body?JSON.parse(options.body):{};
  calls.push({path,method,requestId:body.requestId,promptId:body.promptId}); // Never retain input values.
  if(path==='config')return mode==='config-error'?json({error:'隔离 QA：配置读取失败'},503):json(config);
  if(path==='login' && method==='POST'){
    const id=body.requestId;if(flows.has(id))return json({id});const flow=freshFlow(id,body.provider,body.type);flows.set(id,flow);
    if(mode==='progress')window.__MODEL_AUTH_QA__.progress(id);if(mode==='success')window.__MODEL_AUTH_QA__.complete(id);if(mode==='failed')window.__MODEL_AUTH_QA__.fail(id);
    if(mode==='late-start'){mode='';return await new Promise(resolve=>{releaseStart=()=>{flows.set(id,freshFlow(id,body.provider,body.type));resolve(json({id}));};});}
    if(mode==='lost-start'){mode='';holdState=true;throw new TypeError('isolated simulated lost response');}
    return json({id});
  }
  const match=path.match(/^login\/([^/]+)(?:\/(input|cancel))?$/);
  if(match){
    const flow=flows.get(match[1]);if(!flow)return json({error:'Login expired'},404);
    if(match[2]==='cancel'){flow.status='cancelled';delete flow.prompt;return json({cancelled:true});}
    if(match[2]==='input'){
      if(flow.status!=='pending'||flow.prompt?.id!==body.promptId)return json({error:'登录步骤已失效'},409);
      const apply=()=>{if(flow.status!=='pending')return;delete flow.prompt;
        if(body.value==='device_code')flow.events=[{type:'device_code',userCode:'QA-ONLY',verificationUri:fakeAuthUrl,expiresInSeconds:900,intervalSeconds:1}];
        else if(body.value==='browser'){flow.events=browserEvents();flow.prompt={id:flow.id+'-manual',type:'manual_code',message:'隔离 QA：输入任意假回跳地址，测试轮询时草稿保留'};}
        else window.__MODEL_AUTH_QA__.complete(flow.id);};
      if(mode==='late-answer'){mode='';return await new Promise(resolve=>{releaseAnswer=()=>{apply();resolve(json({submitted:true}));};});}
      apply();return json({submitted:true});
    }
    if(holdState)return await new Promise(resolve=>{releaseState=()=>resolve(json(flow));});
    if(mode==='lost-poll'){mode='';throw new TypeError('isolated simulated lost status read');}
    return json(flow);
  }
  if(path==='model'){
    const model=providers.find(p=>p.id===body.provider)?.models.find(m=>m.id===body.model);
    if(!model?.thinkingLevels.includes(body.thinkingLevel))return json({error:'隔离 QA：该模型不支持所选思考强度'},400);
    config={...config,current:{provider:body.provider,model:body.model,thinkingLevel:body.thinkingLevel}};return json({applied:true});
  }
  if(path==='logout'){const provider=providers.find(p=>p.id===body.provider);provider.credential=null;provider.configured=false;return json({applied:true});}
  return json({error:'QA fixture endpoint missing'},404);
};
const runtime={status:{active:{id:'qa-only',baseUrl:'/qa',mode:parameters.has('remote')?'tailnet':parameters.has('native')?'builtin':'direct',profile:{name:parameters.has('remote')?'隔离 QA 远端工作空间':'隔离 QA 工作空间'}},profiles:[]},busy:false,managed:false,registerBeforeSwitch(){return()=>{};}};
function Fixture(){const[open,setOpen]=useState(true);return <Theme className="app-theme" radius="large" appearance="light" accentColor="tomato" grayColor="sand">
  <div style={{position:'fixed',top:2,left:4,zIndex:2147483647,fontSize:10,lineHeight:'14px',background:'#fff2d8',color:'#644a37',padding:'2px 6px',borderRadius:5,pointerEvents:'none'}}>隔离 QA · 全部假数据 · 无真实授权</div>
  <main style={{padding:24}}><Button onClick={()=>setOpen(true)}>打开隔离模型设置</Button></main>
  <SettingsPage open={open} onOpenChange={setOpen} runtime={runtime} initialTab="pi"/>
</Theme>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
