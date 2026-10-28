// Test-only read guard: rejects startup reads outside the real bundle and isolated home.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
const write=fs.writeFileSync.bind(fs);
const roots=JSON.parse(process.env.PIBOT_TEST_ALLOWED_ROOTS);
const report=process.env.PIBOT_TEST_BOUNDARY_REPORT;
const attempts=new Map();
function check(path,method){
 if(typeof path==='number')return;
 if(path instanceof URL)path=fileURLToPath(path);
 if(Buffer.isBuffer(path))path=path.toString();
 if(typeof path!=='string')return;
 const value=resolve(path);
 const comparable=process.platform==='darwin'?value.toLowerCase():value;
 if(roots.some(root=>{root=process.platform==='darwin'?root.toLowerCase():root;return comparable===root||comparable.startsWith(root+sep)}))return;
 if(!attempts.has(value)&&attempts.size<120){attempts.set(value,{path:value,method,stack:new Error().stack.split('\n').slice(2,7)});write(report,JSON.stringify([...attempts.values()],null,2));}
 const error=Object.assign(Error('Diagnostic denied access outside bundle/test home'),{code:'ENOENT',path:value});
 throw error;
}
for(const key of ['readFileSync','statSync','lstatSync','readdirSync','realpathSync','existsSync','accessSync']){
 const original=fs[key];
 fs[key]=function(path,...args){try{check(path,key);}catch(e){if(key==='existsSync')return false;throw e;}return original.call(fs,path,...args);};
 if(original.native)fs[key].native=(path,...args)=>{check(path,key+'.native');return original.native(path,...args)};
}
for(const key of ['readFile','stat','lstat','readdir','realpath','access']){
 const original=fsp[key];fsp[key]=async function(path,...args){check(path,'promises.'+key);return original.call(fsp,path,...args)};
}
syncBuiltinESMExports();
