/** One draft has one stable key; a transport error never silently creates a new operation. */
export function createBotAttempt(makeKey:()=>string=()=>crypto.randomUUID()) {
    let pending=false,attempt:{fingerprint:string;key:string;result?:any;legacyUncertain?:boolean}|undefined;
    const uncertain=()=>Object.assign(Error('旧版服务未确认创建结果，请先检查 bot 列表或更新服务；不要重复创建'),{reason:'reviewRequired'});
    return {
        get pending(){return pending;},
        reset(){if(!pending)attempt=undefined;},
        async submit(api:{bot:{create(input:{name:string;key?:string;description?:string;channelId?:string}):Promise<any>}},input:{name:string;description?:string;channelId?:string}){
            if(pending)return undefined;
            const fingerprint=JSON.stringify(input);
            if(!attempt||attempt.fingerprint!==fingerprint)attempt={fingerprint,key:makeKey()};
            if(attempt.result!==undefined)return attempt.result;
            if(attempt.legacyUncertain)throw uncertain();
            pending=true;
            try{
                try{attempt.result=await api.bot.create({...input,key:attempt.key});}
                catch(e:any){
                    // Old registries reject unknown /key before entering the handler. Only
                    // this exact validation outcome permits a compatibility request.
                    const paths=e?.details?.paths;
                    if(e?.reason!=='invalidParams'||!Array.isArray(paths)||!paths.includes('/key')||!paths.includes('')||!paths.every(p=>p==='/key'||p===''))throw e;
                    try{attempt.result=await api.bot.create(input);}
                    catch(error:any){
                        if(!['invalidParams','capacity','notInitialized','shuttingDown','setupRequired'].includes(error?.reason)){attempt.legacyUncertain=true;throw uncertain();}
                        throw error;
                    }
                }
                return attempt.result;
            }finally{pending=false;}
        }
    };
}
