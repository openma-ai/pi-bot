/** A controlling local terminal is required. Nothing is accepted in argv/env or echoed. */
export async function readServicePassword(): Promise<string> {
    if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Run service-password in your local terminal');
    const read=(prompt:string)=>new Promise<string>((resolve,reject)=>{
        process.stdout.write(prompt);let value='';process.stdin.setRawMode(true);process.stdin.resume();
        const finish=()=>{process.stdin.off('data',data);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');};
        const data=(chunk:Buffer)=>{for(const c of chunk.toString('utf8')){if(c==='\u0003'){finish();reject(Error('Cancelled'));return;}if(c==='\r'||c==='\n'){finish();resolve(value);return;}if(c==='\u007f'){value=value.slice(0,-1);}else if(c>=' '){value+=c;if(Buffer.byteLength(value)>512){finish();reject(Error('Password too long'));return;}}}};process.stdin.on('data',data);
    });
    const first=await read('New Pibo service password (minimum 12 characters): '),second=await read('Confirm password: ');
    if(first!==second||first.length<12)throw Error('Passwords must match and contain at least 12 characters');return first;
}
