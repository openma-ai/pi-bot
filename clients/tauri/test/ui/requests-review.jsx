import React,{useLayoutEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Theme} from '@radix-ui/themes';
import '@radix-ui/themes/styles.css';
import '/src/gui/style.css';
import '/src/gui/components.css';
import '/src/gui/brand.css';
import {ConversationRequests,RequestAttention} from '/src/gui/ConversationRequests.jsx';
import {ActivityStatus} from '/src/gui/ActivityStatus.jsx';
import {FloatingComposer} from '/src/gui/FloatingComposer.jsx';
import {FeedStatus} from '/src/gui/FeedStatus.jsx';
import {MessageBody} from '/src/gui/MessageBody.jsx';
import {Textarea} from '/src/gui/ui/textarea.jsx';
import {isComposerSubmit} from '/src/gui/composer-keyboard.ts';

// Only synthetic requests and messages. Every network request is blocked.
window.fetch=async()=>{throw new Error('Isolated request QA blocks network');};
const calls=[],sent=[];
const initial={groups:[],bots:[{id:'qa-bot',name:'QA bot'}],threads:[{id:'qa-thread',scope:{channelId:null}}],requests:[
 {id:'qa-approval',botId:'qa-bot',threadId:'qa-thread',kind:'approval',status:'pending',params:{tool:'bash',label:'隔离 QA：查看工作目录',args:{command:'pwd'}}},
 {id:'qa-other',botId:'other-bot',threadId:'qa-thread',kind:'approval',status:'pending',params:{tool:'fixture',args:{}}}
]};
const sample='中文输入：p w d 是什么？';
function Fixture(){
 const [data,setData]=useState(initial),[draft,setDraft]=useState('');const conversation=useRef(),pinned=useRef(true);
 const missing=new URLSearchParams(location.search).has('missing');
 const activity=new URLSearchParams(location.search).get('activity');
 const longMessage=new URLSearchParams(location.search).has('long');
 const shortFeed=new URLSearchParams(location.search).has('short');
 const api={request:{resolve:async(value)=>{calls.push(value);await new Promise(resolve=>setTimeout(resolve,50));setData(old=>({...old,requests:old.requests.map(r=>r.id===value.requestId?{...r,status:'resolved',response:value.response}:r)}));}}};
 window.__REQUEST_QA__={calls,sent,sample};
 useLayoutEffect(()=>{conversation.current.scrollTop=conversation.current.scrollHeight;},[]);
 return <Theme className="app-theme" radius="large" appearance="light" accentColor="tomato" grayColor="sand">
  <div style={{position:'fixed',top:2,left:4,zIndex:2147483647,fontSize:10,background:'#fff2d8',padding:'2px 6px',pointerEvents:'none'}}>隔离 QA · 假审批/假消息 · 无真实操作</div>
  <main className="main qa-request-layout" style={{height:'100dvh',maxWidth:900,margin:'auto',display:'flex',flexDirection:'column',overflow:'hidden'}}>
   <header style={{padding:'28px 20px 16px',flexShrink:0}}><strong>请求与中文输入 QA</strong></header>
   <section ref={conversation} className="conversation" aria-label="聊天消息" onScroll={()=>{const e=conversation.current;pinned.current=e.scrollHeight-e.scrollTop-e.clientHeight<80;}} style={{flex:1,minHeight:0,overflowY:'auto',paddingInline:20,paddingTop:12}}>
    <div className="conversation-feed">
    {!missing&&!activity&&<ConversationRequests data={data} kind="bot" id="qa-bot" api={api}/>}
    {Array.from({length:shortFeed?1:24},(_,i)=><div className="row" key={i}><div className="bubble"><MessageBody text={'隔离测试消息 '+(i+1)}/></div></div>)}
    <div className="row user"><div className="bubble"><MessageBody text={longMessage ? sample.repeat(40) : sample}/></div></div>
    </div>
    <FeedStatus>
    {activity ? <ActivityStatus id="qa-bot" name="QA bot" activity={activity}/> : <RequestAttention data={data} kind="bot" id="qa-bot" api={api}/>}
    </FeedStatus>
   </section>
   <FloatingComposer conversationRef={conversation} pinnedToEnd={pinned}>
    <div className="composer-shell"><div className="composer">
     <Textarea className="message-input" aria-label="消息" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(isComposerSubmit(e)){e.preventDefault();sent.push(draft);setDraft('');}}}/>
    </div></div>
   </FloatingComposer>
  </main>
 </Theme>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
