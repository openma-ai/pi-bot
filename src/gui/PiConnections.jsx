import React,{useState} from 'react';
import {Button,Text,TextField} from '@radix-ui/themes';
import {ArrowLeft,ChevronRight,Plus} from 'lucide-react';
import {Choice} from './PiChoice.jsx';
import {endpointInputError} from './pi-connections.ts';
import './pi-connections.css';

export function ConnectionList({connections,providers,currentId,busy,onAdd,onManage,onBack}) {
  return <section className="pi-mode-content" aria-label="模型连接">
    <div className="pi-field-heading"><Button variant="ghost" color="gray" onClick={onBack}><ArrowLeft size={14}/>返回模型</Button><Button size="2" onClick={onAdd} disabled={busy}><Plus size={15}/>添加连接</Button></div>
    <div className="pi-connections-list" role="list" aria-label="已保存的模型连接">
      {connections.map(c=><div role="listitem" key={c.id}><button type="button" className="pi-connection-row" disabled={busy} onClick={()=>onManage(c.id)}>
        <span><strong>{c.name}</strong><small>{providers.find(p=>p.id===c.providerId)?.name||'自定义服务'}{c.endpoint?.baseUrl?' · '+c.endpoint.baseUrl:''}</small></span>
        <span className="pi-connection-state">{c.catalog?.authChecked===false?'状态待确认':c.configured?'已连接':'尚未认证'}{c.id===currentId?' · 当前模型':''}<ChevronRight size={15}/></span>
      </button></div>)}
      {!connections.length&&<Text size="2" color="gray">连接一个账号或服务后选择模型。</Text>}
    </div>
  </section>;
}

export function ConnectionEditor({providers,connection,canCustom=true,apiOptions,onSave,onCancel,busy}) {
  const [id]=useState(()=>connection?.id||crypto.randomUUID());
  const [providerId,setProviderId]=useState(connection?.providerId||'');
  const [name,setName]=useState(connection?.name||'');
  const [baseUrl,setBaseUrl]=useState(connection?.endpoint?.baseUrl||'');
  const [api,setApi]=useState(connection?.endpoint?.api||apiOptions?.[0]?.id||'openai-completions');
  const [models,setModels]=useState(connection?.endpoint?.models||[{id:'',name:'',contextWindow:'',maxTokens:'',reasoning:false,input:['text']}]);
  const [error,setError]=useState('');
  const custom=providerId==='custom';
  const patch=(index,fields)=>setModels(old=>old.map((m,i)=>i===index?{...m,...fields}:m));
  function save(event){
    event.preventDefault();setError('');
    if(!name.trim()||!providerId){setError('填写连接名称并选择提供商');return;}
    if(custom){const bad=endpointInputError(baseUrl);if(bad){setError(bad);return;}
      if(!models.length||models.some(m=>!m.id.trim()||!Number.isSafeInteger(Number(m.contextWindow))||Number(m.contextWindow)<256||Number(m.contextWindow)>10000000||!Number.isSafeInteger(Number(m.maxTokens))||Number(m.maxTokens)<=0||Number(m.maxTokens)>Number(m.contextWindow))){setError('请填写模型 ID、上下文长度和最大输出长度');return;}
      if(new Set(models.map(m=>m.id.trim())).size!==models.length){setError('同一连接内模型 ID 不能重复');return;}}
    void onSave({id,name:name.trim(),providerId,...(connection?{expectedRevision:connection.revision}:{}),...(custom?{endpoint:{baseUrl:baseUrl.trim(),api,models:models.map(m=>({...m,id:m.id.trim(),name:(m.name||'').trim()||m.id.trim(),contextWindow:Number(m.contextWindow),maxTokens:Number(m.maxTokens)}))}}:{})});
  }
  return <form className="pi-mode-content pi-connection-editor" aria-label={connection?'编辑模型连接':'添加模型连接'} onSubmit={save}>
    <div className="pi-field-heading"><Button type="button" variant="ghost" color="gray" disabled={busy} onClick={onCancel}><ArrowLeft size={14}/>取消并返回</Button><Text size="2" weight="medium">{connection?'编辑连接':'添加连接'}</Text></div>
    <label>连接名称<TextField.Root aria-label="连接名称" maxLength={100} value={name} disabled={busy} placeholder="例如：工作账号" onChange={e=>setName(e.target.value)}/></label>
    <Choice label="模型提供商" value={providerId} onChange={setProviderId} disabled={busy||!!connection} searchable items={[...providers.map(p=>({id:p.id,name:p.name,detail:[p.methodLabels?.oauth,p.methods?.includes('api_key')?'API key':''].filter(Boolean).join(' · ')})),...(canCustom?[{id:'custom',name:'自定义服务',detail:'配置兼容 API 地址与模型'}]:[])]}/>
    {custom&&<>
      <label>API 地址<TextField.Root aria-label="API 地址" type="url" value={baseUrl} disabled={busy} placeholder="https://service.example/v1" onChange={e=>setBaseUrl(e.target.value)}/></label>
      <Choice label="API 协议" value={api} onChange={setApi} disabled={busy} items={apiOptions||[{id:'openai-completions',name:'OpenAI Chat Completions'},{id:'openai-responses',name:'OpenAI Responses'}]}/>
      {models.map((m,i)=><fieldset className="pi-endpoint-model" key={i}><legend>模型 {i+1}</legend>
        <label>模型 ID<TextField.Root aria-label={'模型 ID '+(i+1)} value={m.id} disabled={busy} onChange={e=>patch(i,{id:e.target.value})}/></label>
        <label>显示名称<TextField.Root aria-label={'模型名称 '+(i+1)} value={m.name} disabled={busy} onChange={e=>patch(i,{name:e.target.value})}/></label>
        <div className="pi-endpoint-limits"><label>上下文长度<TextField.Root aria-label={'上下文长度 '+(i+1)} type="number" min="256" max="10000000" value={m.contextWindow} disabled={busy} onChange={e=>patch(i,{contextWindow:e.target.value})}/></label><label>最大输出<TextField.Root aria-label={'最大输出 '+(i+1)} type="number" min="1" value={m.maxTokens} disabled={busy} onChange={e=>patch(i,{maxTokens:e.target.value})}/></label></div>
        <label className="pi-checkbox"><input type="checkbox" checked={m.reasoning} disabled={busy} onChange={e=>patch(i,{reasoning:e.target.checked})}/>支持推理</label>
        {models.length>1&&<Button type="button" variant="ghost" color="gray" disabled={busy} onClick={()=>setModels(old=>old.filter((_,n)=>n!==i))}>移除此模型</Button>}
      </fieldset>)}
      <Button type="button" variant="soft" disabled={busy||models.length>=20} onClick={()=>setModels(old=>[...old,{id:'',name:'',contextWindow:'',maxTokens:'',reasoning:false,input:['text']}])}>添加模型</Button>
      <Text size="1" color="gray">按服务提供的规格填写。更改地址或模型规格后需要重新认证，已有凭据不会转发到新地址。</Text>
    </>}
    {error&&<Text role="alert" color="red" size="2">{error}</Text>}
    <div className="pi-editor-footer"><Button type="submit" disabled={busy}>{busy?'正在保存…':connection?'保存连接':'保存并继续认证'}</Button></div>
  </form>;
}
