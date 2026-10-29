import React, { useEffect, useRef, useState } from 'react';
import './message-reactions.css';
const choices=['❤️','👍','😂','🎉','🤔','👀'];
export function MessageReactions({message,api,viewerActorId}) {
    const [reactions,setReactions]=useState(message.reactions??[]),[actor,setActor]=useState(viewerActorId),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
    const epoch=useRef(0),pending=useRef(false);
    const key=JSON.stringify([message.messageId,message.direction,message.channelId,message.conversationId,message.threadId]);
    useEffect(()=>{epoch.current++;pending.current=false;setBusy(false);setOpen(false);setError('');setActor(viewerActorId);return()=>{epoch.current++;};},[key,viewerActorId]);
    useEffect(()=>setReactions(message.reactions??[]),[key,message.reactions]);
    if(!message.messageId||!message.channelId||!message.conversationId||!['inbound','outbound'].includes(message.direction)||message.streaming)return null;
    const emojis=[...new Set(reactions.map(r=>r.emoji))];
    async function change(emoji) {
        if(pending.current||!api?.message?.setReaction)return;
        pending.current=true;setBusy(true);setError('');const version=epoch.current;
        try {
            const result=await api.message.setReaction({messageId:message.messageId,direction:message.direction,channelId:message.channelId,conversationId:message.conversationId,threadId:message.threadId??null,emoji,present:!reactions.some(r=>r.emoji===emoji&&r.actorId===actor)});
            if(version===epoch.current){setReactions(result.reactions);setActor(result.actorId);setOpen(false);}
        } catch {if(version===epoch.current)setError('表情未更新，请重试');}
        finally {if(version===epoch.current){pending.current=false;setBusy(false);}}
    }
    return <div className="message-reactions" aria-label="消息表情" aria-busy={busy}>
        {emojis.map(emoji=><button type="button" className="message-reaction" key={emoji} aria-label={emoji+' 表情'} aria-pressed={reactions.some(r=>r.emoji===emoji&&r.actorId===actor)} disabled={busy||!api?.message?.setReaction} onClick={()=>void change(emoji)}>{emoji}<span>{reactions.filter(r=>r.emoji===emoji).length}</span></button>)}
        {api?.message?.setReaction&&<button type="button" className="message-reaction-add" aria-label="添加表情" aria-expanded={open} disabled={busy} onClick={()=>setOpen(v=>!v)}>☺<span aria-hidden="true">＋</span></button>}
        {open&&<div className="message-reaction-picker" role="group" aria-label="选择表情" onKeyDown={e=>{if(e.key==='Escape'){setOpen(false);e.stopPropagation();}}}>
            {choices.map(emoji=><button type="button" key={emoji} aria-label={'使用 '+emoji} disabled={busy} onClick={()=>void change(emoji)}>{emoji}</button>)}
            <button type="button" aria-label="取消选择表情" onClick={()=>setOpen(false)}>×</button>
        </div>}
        {error&&<span className="message-reaction-error" role="status">{error}</span>}
    </div>;
}
