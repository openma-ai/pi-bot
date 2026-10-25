type Profile={id:string;name?:string;mode?:string};
type StorageLike={getItem(key:string):string|null;setItem(key:string,value:string):void};
type Status={profiles?:Profile[]|null;active?:unknown};
/** Persist only connection intent, never a password/session token. */
export function createRuntimeRestoration(storage:StorageLike|undefined,now=()=>Date.now()) {
    const read=(k:string)=>{try{return storage?.getItem(k);}catch{return null;}};
    const write=(k:string,v:string)=>{try{storage?.setItem(k,v);}catch{/* A storage failure must not break an active connection. */}};
    let id=read('pibo.lastConnection'),enabled=read('pibo.restoreEnabled')!=='0',blocked=false,nextAt=0,failures=0;
    let remembered:Profile|null=null;try{remembered=JSON.parse(read('pibo.lastRuntime')||'null');}catch{}
    const optedIn=()=>enabled&&read('pibo.restoreEnabled')!=='0';
    return {
        candidate(status:Status,{hidden=false,busy=false}={}){
            if(!optedIn()||blocked||hidden||busy||status.active||!id||now()<nextAt)return null;
            return status.profiles?.find(p=>p.id===id&&['local','direct','tailnet'].includes(p.mode||''))||null;
        },
        display(profiles:Profile[]|null|undefined){if(!optedIn()||!id)return null;const p=profiles?.find(p=>p.id===id)||remembered;return {id,name:p?.name||"上次连接的工作空间",mode:p?.mode};},
        removed(profileId:string){if(profileId===id){enabled=false;write('pibo.restoreEnabled','0');}},
        manual(){blocked=true;},
        connected(profile:Profile){id=profile.id;enabled=true;blocked=false;failures=0;nextAt=0;write('pibo.lastConnection',id);write('pibo.restoreEnabled','1');remembered={id:profile.id,name:profile.name,mode:profile.mode};write('pibo.lastRuntime',JSON.stringify(remembered));},
        failed(error:unknown){
            const text=String(error instanceof Error?error.message:error);
            if(/401|403|会话已过期|会话.*撤销|请先使用服务访问密码登录|请先在连接管理登录|批准应用内|SSH 连接已停用/.test(text)){blocked=true;return;}
            failures++;nextAt=now()+[1000,2000,5000,10000,30000][Math.min(failures-1,4)];
        },
        foreground(){if(!blocked)nextAt=0;},
        disable(){enabled=false;blocked=true;write('pibo.restoreEnabled','0');},
    };
}
