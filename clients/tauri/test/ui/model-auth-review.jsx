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
const providers = [
  {id:'openai',name:'OpenAI',methods:['api_key','oauth'],methodLabels:{api_key:'OpenAI API key',oauth:'Sign in with ChatGPT'},credential:null,models:[{id:'qa-model',name:'QA fixture model',reasoning:true},{id:'qa-fast',name:'QA fixture fast',reasoning:false}]},
  {id:'openai-codex',name:'OpenAI Codex (legacy)',methods:['oauth'],methodLabels:{oauth:'OpenAI (ChatGPT Plus/Pro)'},credential:null,models:[{id:'qa-codex',name:'QA fixture Codex',reasoning:true}]},
  {id:'deepseek',name:'DeepSeek',methods:['api_key'],methodLabels:{api_key:'DeepSeek API key'},credential:null,models:[{id:'qa-deepseek',name:'QA fixture DeepSeek',reasoning:true}]},
];
let config = {current:{provider:'',model:'',thinkingLevel:'high'},providers,reloadPending:false};
if(parameters.has('configured')){providers[0].credential='oauth';config.current={provider:'openai',model:'qa-model',thinkingLevel:'high'};}
const flows = new Map(), calls = [];
const warnings=[],warn=console.warn.bind(console);
console.warn=(...args)=>{warnings.push(args.filter(v=>typeof v==='string').join(' '));warn(...args);};
let mode = parameters.get('mode') || '', releaseStart, releaseAnswer, releaseState, holdState=false;
const freshFlow = (id,provider,type) => ({id,providerId:provider,type,status:'pending',events:[],expiresAt:Date.now()+900000,
  prompt:type === 'api_key' ? {id:id+'-key',type:'secret',message:'隔离 QA：仅可输入假密钥'} : provider === 'openai-codex' ?
  {id:id+'-method',type:'select',message:'Select OpenAI Codex login method:',options:[{id:'browser',label:'Browser login (default)'},{id:'device_code',label:'Device code login (headless)'}]} :
  {id:id+'-manual',type:'manual_code',message:'隔离 QA：粘贴假回调内容，不会发起真实授权'}});
const json = (value,status=200) => Response.json(structuredClone(value),{status});
window.__MODEL_AUTH_QA__ = {calls,flows,warnings,configuration(){return structuredClone(config);},setMode(value){mode=value;},releaseStart(){releaseStart?.();},releaseAnswer(){releaseAnswer?.();},releaseState(){holdState=false;releaseState?.();},
  complete(id,persist=true){const flow=flows.get(id);if(flow){flow.status='complete';delete flow.prompt;if(persist)providers.find(p=>p.id===flow.providerId).credential=flow.type;}}};
window.fetch = async (input,options={}) => {
  const url = new URL(typeof input==='string'?input:input.url, location.href), method=options.method||'GET';
  if(url.origin!==location.origin || !url.pathname.startsWith('/qa/pi/')) throw new Error('QA fixture blocked external or unmocked request');
  const path=url.pathname.slice('/qa/pi/'.length), body=options.body?JSON.parse(options.body):{};
  calls.push({path,method,requestId:body.requestId,promptId:body.promptId}); // Never retain input values.
  if(path==='config')return mode==='config-error'?json({error:'隔离 QA：配置读取失败'},503):json(config);
  if(path==='login' && method==='POST'){
    const id=body.requestId; const flow=freshFlow(id,body.provider,body.type);flows.set(id,flow);
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
        if(body.value==='device_code')flow.events=[{type:'device_code',userCode:'QA-ONLY',verificationUri:'https://example.invalid/qa-no-oauth',expiresInSeconds:900,intervalSeconds:1}];
        else if(body.value==='browser')flow.prompt={id:flow.id+'-manual',type:'manual_code',message:'隔离 QA：输入任意假回调，测试轮询时草稿保留'};
        else window.__MODEL_AUTH_QA__.complete(flow.id);};
      if(mode==='late-answer'){mode='';return await new Promise(resolve=>{releaseAnswer=()=>{apply();resolve(json({submitted:true}));};});}
      apply();return json({submitted:true});
    }
    if(holdState)return await new Promise(resolve=>{releaseState=()=>resolve(json(flow));});
    if(mode==='lost-poll'){mode='';throw new TypeError('isolated simulated lost status read');}
    return json(flow);
  }
  if(path==='model'){config={...config,current:{provider:body.provider,model:body.model,thinkingLevel:body.thinkingLevel}};return json({applied:true});}
  if(path==='logout'){providers.find(p=>p.id===body.provider).credential=null;return json({applied:true});}
  return json({error:'QA fixture endpoint missing'},404);
};
const runtime={status:{active:{id:'qa-only',baseUrl:'/qa',profile:{name:'隔离 QA 工作空间'}},profiles:[]},busy:false,managed:false,registerBeforeSwitch(){return()=>{};}};
function Fixture(){const[open,setOpen]=useState(true);return <Theme className="app-theme" radius="large" appearance="light" accentColor="tomato" grayColor="sand">
  <div style={{position:'fixed',top:2,left:4,zIndex:2147483647,fontSize:10,lineHeight:'14px',background:'#fff2d8',color:'#644a37',padding:'2px 6px',borderRadius:5,pointerEvents:'none'}}>隔离 QA · 全部假数据 · 无真实授权</div>
  <main style={{padding:24}}><Button onClick={()=>setOpen(true)}>打开隔离模型设置</Button></main>
  <SettingsPage open={open} onOpenChange={setOpen} runtime={runtime} initialTab="pi"/>
</Theme>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
