type Profile={id:string;name?:string;mode?:string};
type StorageLike={getItem(key:string):string|null;setItem(key:string,value:string):void};
type Status={profiles?:Profile[]|null;active?:unknown};
/** Persist only connection intent, never a password/session token. */
export function createRuntimeRestoration(storage:StorageLike|undefined) {
    const read=(k:string)=>{try{return storage?.getItem(k);}catch{return null;}};
    const write=(k:string,v:string)=>{try{storage?.setItem(k,v);}catch{/* A storage failure must not break an active connection. */}};
    let id=read('pibo.lastConnection'),enabled=read('pibo.restoreEnabled')!=='0',blocked=false;
    let remembered:Profile|null=null;try{remembered=JSON.parse(read('pibo.lastRuntime')||'null');}catch{}
    const optedIn=()=>enabled&&read('pibo.restoreEnabled')!=='0';
    return {
        candidate(status:Status,{hidden=false,busy=false}={}){
            if(!optedIn()||blocked||hidden||busy||status.active||!id)return null;
            return status.profiles?.find(p=>p.id===id&&['builtin','local','direct','tailnet'].includes(p.mode||''))||null;
        },
        display(profiles:Profile[]|null|undefined){if(!optedIn()||!id)return null;const p=profiles?.find(p=>p.id===id)||remembered;return {id,name:p?.name||"上次连接的工作空间",mode:p?.mode};},
        removed(profileId:string){if(profileId===id){enabled=false;write('pibo.restoreEnabled','0');}},
        manual(){blocked=true;},
        connected(profile:Profile){id=profile.id;enabled=true;blocked=false;write('pibo.lastConnection',id);write('pibo.restoreEnabled','1');remembered={id:profile.id,name:profile.name,mode:profile.mode};write('pibo.lastRuntime',JSON.stringify(remembered));},
        failed(_error:unknown){
            // One automatic attempt, then leave a stable recovery screen. The user
            // can retry or configure another workspace without a polling loop.
            blocked=true;
        },

        disable(){enabled=false;blocked=true;write('pibo.restoreEnabled','0');},
    };
}
