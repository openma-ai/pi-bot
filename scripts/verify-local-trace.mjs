import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { LocalTrace } from '../src/daemon/observability/local-trace.ts';
import { FrontendLatency } from '../src/sdk/frontend-latency.ts';
const require=createRequire(import.meta.url);
const protobuf=require('protobufjs'),descriptor=require('protobufjs/ext/descriptor');
// No package installation/download, network requests or real runtime data access.
const argv=process.argv.slice(2),options={};
for(let i=0;i<argv.length;i+=2) {
 if(!['--schema-dir','--out-dir'].includes(argv[i])||!argv[i+1]||options[argv[i]])throw Error('Usage: node --import tsx scripts/verify-local-trace.mjs --schema-dir PATH --out-dir NEW_PATH');
 options[argv[i]]=argv[i+1];
}
if(!options['--schema-dir']||!options['--out-dir'])throw Error('--schema-dir and a new --out-dir are required');
const target=resolve(options['--out-dir']),schema=resolve(options['--schema-dir']);
// Refuse existing outputs, so verification never overwrites prior artifacts.
mkdirSync(target);
const root=new protobuf.Root();root.resolvePath=(_origin,path)=>join(schema,path);
await root.load('opentelemetry/proto/collector/trace/v1/trace_service.proto',{keepCase:true});root.resolveAll();
const set=root.toDescriptor('proto3');
// ext/descriptor uses relative type names and inclusive reserved ends. Protobuf
// FileDescriptorProto requires fully qualified names and exclusive message ends.
function repairMessage(message,fullName) {
 const source=root.lookupType(fullName);
 for(const field of message.field) {
  const original=source.fieldsById[field.number];
  if(original.resolvedType)field.typeName=original.resolvedType.fullName;
 }
 for(const range of message.reservedRange??[])range.end++;
 for(const nested of message.nestedType??[])repairMessage(nested,fullName+'.'+nested.name);
}
for(const file of set.file) {
 for(const message of file.messageType)repairMessage(message,'.'+file.package+'.'+message.name);
 for(const service of file.service) {
  const original=root.lookupService('.'+file.package+'.'+service.name);
  for(const method of service.method) {
   method.inputType=original.methods[method.name].resolvedRequestType.fullName;
   method.outputType=original.methods[method.name].resolvedResponseType.fullName;
  }
 }
}
// protobufjs preserves the official message fields, but omits inter-file imports.
// Restore only those dependencies, using the actual referenced type packages.
for(const file of set.file) {
 const json=JSON.stringify(file);
 file.dependency=set.file.filter(other=>other!==file&&json.includes('.'+other.package+'.')).map(other=>other.name);
}
writeFileSync(join(target,'trace.descriptor.pb'),descriptor.FileDescriptorSet.encode(set).finish());
const files=['common/v1/common.proto','resource/v1/resource.proto','trace/v1/trace.proto','collector/trace/v1/trace_service.proto'];
const hashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(join(schema,'opentelemetry/proto',file))).digest('hex')]));
const journal=mkdtempSync(join(target,'fixture-'));const trace=new LocalTrace(journal);
const scope={inputId:'synthetic-source',turnId:'trn_00000000-0000-0000-0000-000000000001'};
trace.point(scope,'run.start');
for(const outcome of ['ok','error','cancelled','blocked'])trace.boundary(scope,{kind:'provider',phase:'end',id:outcome,elapsedMs:2,outcome});
trace.boundary(scope,{kind:'tool',phase:'end',id:'outer',tool:'codemode',outcome:'ok',elapsedMs:2});
trace.boundary(scope,{kind:'tool',phase:'end',id:'inner',parentToolCallId:'outer',tool:'send_message',outcome:'ok',elapsedMs:1});
trace.point(scope,'run.end',{status:'completed',elapsedMs:8});
const records=readFileSync(join(journal,'latency.otlp.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
for(let i=0;i<2;i++){const f=new FrontendLatency();f.received({primaryInputId:scope.inputId,turnId:scope.turnId,itemId:'same-item',serverAt:Date.now()});await f.committed('same-item');records.push(...f.snapshot());}
writeFileSync(join(target,'fixture.otlp.jsonl'),records.map(r=>JSON.stringify(r)).join('\n')+'\n');
const bench=mkdtempSync(join(target,'sync-io-'));const b=new LocalTrace(bench);const durations=[];
for(let i=0;i<100;i++){const at=performance.now();b.point(scope,'message.admitted',{id:String(i)});durations.push(performance.now()-at);}
durations.sort((a,b)=>a-b);
const result={schemaSource:'https://github.com/open-telemetry/opentelemetry-proto',schemaHashes:hashes,protobufjs:require('protobufjs/package.json').version,records:records.length,ioSample:{count:100,p50Ms:durations[49],p95Ms:durations[94],maxMs:durations[99],note:'One local warm-cache synthetic sample, includes encoding/hash/synchronous filesystem calls; not production overhead or a guaranteed upper bound.'}};
writeFileSync(join(target,'preparation.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));

execFileSync('python3',[fileURLToPath(new URL('./verify-local-trace.py',import.meta.url)),target],{stdio:'inherit'});
