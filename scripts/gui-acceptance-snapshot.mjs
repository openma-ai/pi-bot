import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const directory=resolve(process.env.PI_BOT_DIR ?? 'work/gui/demo');
const {token,...state}=await (await fetch('http://127.0.0.1:4317/api/state')).json();
if(!state.budget)throw Error('No active authenticated Pi evaluation round; snapshot would not represent real API usage');
const start=state.budget.expiresAt-60*60*1000;
const usage={responses:0,input:0,output:0,cacheRead:0,reasoning:0,totalTokens:0,estimatedUsd:0};
const files=root=>readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(root,e.name)):[join(root,e.name)]);
for(const file of files(join(directory,'sessions')).filter(f=>f.endsWith('.jsonl')))for(const line of readFileSync(file,'utf8').split('\n'))try{
 const e=JSON.parse(line),m=e.message,u=m?.usage;
 if(m?.role!=='assistant'||m.model!=='deepseek-v4-flash'||!(u?.totalTokens>0)||Date.parse(e.timestamp)<start)continue;
 usage.responses++; for(const key of ['input','output','cacheRead','reasoning','totalTokens'])usage[key]+=Number(u[key]??0); usage.estimatedUsd+=Number(u.cost?.total??0);
}catch{}
const artifact=files(join(directory,'sessions')).find(f=>f.endsWith('/om-peer-result.txt'));
const db=new DatabaseSync(join(directory,'triggers.db'),{readOnly:true});
const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
const report={capturedAt:new Date().toISOString(),...state,roundUsage:usage,artifact:artifact?{path:artifact,text:readFileSync(artifact,'utf8')}:null,triggerTables:tables,triggerCounts:db.prepare('SELECT event_type,state,count(*) AS count FROM openmatter_inbox GROUP BY event_type,state').all()};
db.close();
const output=resolve(process.argv[2]??'work/gui/openmatter-round-3.json');
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,budget:state.budget,roundUsage:usage,artifact:report.artifact,trigger:state.trigger,errors:state.errors,triggerTables:tables,triggerCounts:report.triggerCounts}));
