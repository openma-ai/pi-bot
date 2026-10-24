/** Local-admin initialization only. No plaintext password or bearer is stored. */
import { randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
interface Record { version: 1; salt: string; hash: string }
const hash = (password: string, salt: string) => new Promise<Buffer>((resolve,reject)=>derive(password,Buffer.from(salt,'hex'),32,{N:32768,r:8,p:1,maxmem:64*1024*1024},(e,key)=>e?reject(e):resolve(key)));
export class ServicePassword {
    private record?: Record;
    private active=0;
    private attempts: number[]=[];
    constructor(private dir: string) {
        try {const r=JSON.parse(readFileSync(join(dir,'service-password.json'),'utf8'));if(r.version!==1||!/^([a-f0-9]{32})$/.test(r.salt)||!/^([a-f0-9]{64})$/.test(r.hash))throw Error();this.record=r;}
        catch(e:any){if(e.code!=='ENOENT')throw Error('Invalid service password store');}
    }
    get generation(){return this.record?.salt;}
    get configured(){return !!this.record;}
    async set(password: unknown) {
        if(typeof password!=='string'||password.length<12||Buffer.byteLength(password)>512)throw Error('Use a service password of 12–512 bytes');
        const salt=randomBytes(16).toString('hex');const r:Record={version:1,salt,hash:(await hash(password,salt)).toString('hex')};
        const file=join(this.dir,'service-password.json'),tmp=file+'.'+randomBytes(8).toString('hex');writeFileSync(tmp,JSON.stringify(r),{mode:0o600,flag:'wx'});renameSync(tmp,file);this.record=r;
    }
    async verify(password: unknown):Promise<'ok'|'denied'|'limited'> {
        const now=Date.now();this.attempts=this.attempts.filter(t=>now-t<60000);
        if(this.active>=2||this.attempts.length>=10)return 'limited';
        this.attempts.push(now);
        if(!this.record||typeof password!=='string'||Buffer.byteLength(password)>512)return 'denied';
        this.active++;const record=this.record;
        try {const key=await hash(password,record.salt);return this.record===record&&timingSafeEqual(key,Buffer.from(record.hash,'hex'))?'ok':'denied';}finally{this.active--;}
    }
}
