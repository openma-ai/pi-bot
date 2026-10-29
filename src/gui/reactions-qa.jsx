import React,{useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MessageReactions} from './MessageReactions.jsx';

/** Explicit fixture: no runtime client, credentials, network requests or inference. */
function Fixture(){
    const [id,setId]=useState('one'),[requests,setRequests]=useState(0),[revision,render]=useState(0),[pendingCount,setPendingCount]=useState(0);
    const records=useRef({one:[{actorId:'bot:fixture',emoji:'❤️',createdAt:1}],two:[]}),pending=useRef([]);
    const api=useMemo(()=>({message:{setReaction:target=>new Promise((resolve,reject)=>{setRequests(n=>n+1);pending.current.push({target,resolve,reject});setPendingCount(pending.current.length);})}}),[]);
    function finish(fail){
        const request=pending.current.shift();setPendingCount(pending.current.length);if(!request)return;
        if(fail){request.reject(new Error('synthetic failure'));return;}
        const {target,resolve}=request,previous=records.current[target.messageId]??[];
        const rest=previous.filter(r=>r.actorId!=='user:fixture'||r.emoji!==target.emoji);
        const reactions=target.present?[...rest,{actorId:'user:fixture',emoji:target.emoji,createdAt:2}]:rest;
        records.current[target.messageId]=reactions;resolve({changed:true,actorId:'user:fixture',reactions});render(n=>n+1);
    }
    const message={messageId:id,direction:'inbound',channelId:'fixture',conversationId:'fixture',threadId:null,reactions:records.current[id]};
    return <main data-revision={revision}><h1>消息表情 · 合成验收</h1><p>仅假数据，无模型或账号连接。</p>
        <nav><button onClick={()=>setId('one')}>消息一</button><button onClick={()=>setId('two')}>消息二</button><button onClick={()=>finish(false)}>完成请求</button><button onClick={()=>finish(true)}>失败请求</button><button onClick={()=>render(n=>n+1)}>恢复快照</button></nav>
        <output aria-label="测试状态">message={id}; requests={requests}; pending={pendingCount}</output>
        <article><p>同样的消息文本</p><MessageReactions message={message} api={api} viewerActorId="user:fixture"/></article>
        <p>下面的内容应始终在表情选择器之后，不被覆盖。</p>
    </main>;
}
document.head.insertAdjacentHTML('beforeend',`<style>:root{font-family:system-ui;color:#302e2a;background:#f9f6ef;--pibo-muted:#756b64;--pibo-hover:#eee7de;--pibo-selected:#f7dfd5;--pibo-line:#d9c8bc;--pibo-surface:#fffaf3}body{margin:0}main{max-width:540px;margin:auto;padding:20px;box-sizing:border-box}h1{font-size:22px}nav{display:flex;flex-wrap:wrap;gap:8px}nav button{border:1px solid #d9c8bc;border-radius:10px;padding:8px;background:transparent}output{display:block;margin:18px 0;font-size:13px}article{max-width:100%;padding:18px;border-radius:18px;background:#f2ece3;box-sizing:border-box}article p{margin:0 0 8px}</style>`);
createRoot(document.getElementById('root')).render(<Fixture/>);
