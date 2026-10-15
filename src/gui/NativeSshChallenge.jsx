import React, { useEffect, useState } from "react";
import { Dialog, Button, Flex, Text } from "@radix-ui/themes";
export function NativeSshChallenge() {
  const [challenge,setChallenge]=useState(null), [error,setError]=useState("");
  useEffect(()=>{
    if(!window.__PIBOT_NATIVE__) return;
    let disposed=false; const cleanups=[];
    void import("@tauri-apps/api/event").then(async ({listen})=>{
      for (const [event,callback] of [["ssh-challenge",({payload})=>{setError("");setChallenge(payload);}], ["ssh-challenge-closed",({payload})=>setChallenge(old=>old?.id===payload.id?null:old)]]) {
        const stop=await listen(event,callback); if(disposed)stop();else cleanups.push(stop);
      }
    });
    return ()=>{disposed=true;cleanups.forEach(stop=>stop());};
  },[]);
  async function respond(answers) {
    if(!challenge)return;
    try { await window.__PIBOT_NATIVE__.call("ssh_challenge_reply",{id:challenge.id,answers});setChallenge(null); }
    catch(e){setChallenge(null);setError(String(e));}
  }
  return <Dialog.Root open={!!challenge} onOpenChange={open=>{if(!open)void respond(null);}}><Dialog.Content maxWidth="420px" aria-describedby="ssh-challenge-description">
    <Dialog.Title>SSH 交互验证</Dialog.Title><Dialog.Description id="ssh-challenge-description">以下是已核验 SSH 主机发送的提示。响应仅用于本次认证，不写入聊天或保存。</Dialog.Description>
    <form key={challenge?.id} autoComplete="off" onSubmit={e=>{e.preventDefault();const form=e.currentTarget;const data=new FormData(form);const answers=challenge.prompts.map((_,i)=>String(data.get(String(i))||""));form.reset();void respond(answers);}}>
      {(challenge?.prompts||[]).map((prompt,i)=><label key={i} className="ssh-prompt">{prompt || `验证响应 ${i+1}`}<input name={String(i)} type="password" autoComplete="off" maxLength={4096} /></label>)}
      {error&&<Text role="alert">{error}</Text>}<Flex gap="3" justify="end" mt="4"><Button type="button" variant="soft" onClick={()=>void respond(null)}>取消</Button><Button type="submit">验证</Button></Flex>
    </form>
  </Dialog.Content></Dialog.Root>;
}
