// Small, version-pinned SDK bridge. No execution or sandbox implementation is copied.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
const sdk=dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const pkg=JSON.parse(await readFile(join(sdk,'../package.json'),'utf8'));
if(pkg.version!=='1.1.0')throw Error('Background bridge supports only Pi 1.1.0; review it before upgrading');
const codemode=dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-codemode')));
const codemodePkg=JSON.parse(await readFile(join(codemode,'../package.json'),'utf8'));
if(codemodePkg.version!=='1.1.0')throw Error('Codemode bridge supports only 1.1.0');
const sourcePath=file=>file.startsWith('codemode/')?join(codemode,file.slice(9)):join(sdk,file);
const specs=[
 ['core/nested-tool-calls.js',[
  ['let scope = this.scopes.get(callerId);','const scopeId = options.executionId ?? callerId;\n        let scope = this.scopes.get(scopeId);'],
  ['this.scopes.set(callerId, scope);','this.scopes.set(scopeId, scope);'],
  ['id: `${callerId}/${scope.nextId++}`,','id: `${scopeId}/${scope.nextId++}`,'],
  ['            });\n        }\n        finally {\n            this.scopes.delete(toolCall.id);','            }, options.originatingMessage);\n        }\n        finally {\n            this.scopes.delete(toolCall.id);\n            if (options.executionId) this.scopes.delete(scopeId);'],
 ]],
 ['core/nested-tool-calls.js',[
  ['scope = { recorder: new NestedCallRecorder(), nextId: 1, holdsQueue: false };','scope = { recorder: new NestedCallRecorder(), nextId: 1, holdsQueue: false, detached: Boolean(options.executionId) };'],
  ['holdsQueue: scope.holdsQueue || exclusive,','holdsQueue: scope.holdsQueue || exclusive,\n            detached: scope.detached,'],
  ['this.scopes.clear();','for (const [id, scope] of this.scopes) if (!scope.detached) this.scopes.delete(id);'],
 ]],
 ['core/nested-tool-calls.js',[
  ['        const toolCall = {','        scope.originatingMessage ??= options.originatingMessage;\n        const toolCall = {'],
  ['            detached: scope.detached,','            detached: scope.detached,\n            originatingMessage: scope.originatingMessage,'],
  ['}, options.originatingMessage);','}, options.originatingMessage ?? scope.originatingMessage);'],
 ]],
 ['core/agent-session.js',[
  ['runToolCall: (toolCall, parentId, signal, onUpdate) => {','runToolCall: (toolCall, parentId, signal, onUpdate, originatingMessage) => {'],
  ['const assistantMessage = this._findLastAssistantMessage();','const assistantMessage = originatingMessage ?? this._findLastAssistantMessage();'],
 ]],
 ['core/extensions/runner.js',[
  ['return Object.defineProperties(this.createContext(), {\n            tools:', 'return Object.defineProperties(this.createContext(), {\n            supportsDetachedToolExecution: { value: true },\n            tools:'],
 ]],
 ['core/extensions/types.d.ts',[
  ['export interface ExecuteToolOptions {','export interface ExecuteToolOptions {\n    /** Host-owned unique scope for a detached call. */\n    executionId?: string;\n    /** Immutable original assistant message; does not bypass native hooks. */\n    originatingMessage?: Extract<AgentMessage, { role: "assistant" }>;'],
  ['export interface ExtensionToolContext extends ExtensionContext {','export interface ExtensionToolContext extends ExtensionContext {\n    readonly supportsDetachedToolExecution?: boolean;'],
 ]],
 ['utils/output-files.js',[
  ['import { randomBytes } from "node:crypto";','import { randomBytes } from "node:crypto";\nimport { AsyncLocalStorage } from "node:async_hooks";\nconst outputFileDirectory = new AsyncLocalStorage();\nexport const withOutputFileDirectory = (directory, run) => outputFileDirectory.run(directory, run);'],
  ['return join(tmpdir(), `${prefix}', 'return join(outputFileDirectory.getStore() ?? process.env.PI_TOOL_OUTPUT_DIR ?? tmpdir(), `${prefix}'],
 ]],
 ['codemode/runtime/host.js',[
  ['this.signal = options.signal;','this.signal = options.signal;\n        this.onOutput = options.onOutput;'],
  ['this.output.push(message.item);','this.output.push(message.item);\n                try { this.onOutput?.(message.item); } catch { /* observation cannot corrupt worker dispatch */ }'],
  ['signal: options.signal,','signal: options.signal,\n            onOutput: options.onOutput,'],
 ]],
 ['codemode/types.d.ts',[
  ['export interface CodemodeExecuteOptions {','export interface CodemodeExecuteOptions {\n    /** Observes script text, console and images without ending the execution. */\n    onOutput?: (item: CodemodeOutputItem) => void;'],
 ]],
 ['extensions/codemode/execute.js',[
  ['result = await sandbox.execute(code, { signal, store });','result = await sandbox.execute(code, { signal, store, onOutput: item => onUpdate?.({ content: [], details: { ...snapshot(), scriptOutputItem: item } }) });'],
 ]],
];
// Check all edits before writing any file; originals are kept under the project work directory.
const edits=new Map();
for(const [file,replacements] of specs){
 let text=edits.get(file)?.text ?? await readFile(sourcePath(file),'utf8');const original=edits.get(file)?.original ?? text;
 // Normalize the previous bridge revision before checking the complete patch set.
 if(file==='core/nested-tool-calls.js')text=text.replace('}, options.originatingMessage ?? scope.originatingMessage);','}, options.originatingMessage);');
 if(file==='utils/output-files.js')text=text.replace('return join(process.env.PI_TOOL_OUTPUT_DIR ?? tmpdir(),','return join(tmpdir(),');
 for(const [before,after] of replacements){
  if(text.includes(after))continue;
  if(text.split(before).length!==2)throw Error(`Pi bridge source mismatch: ${file}`);
  text=text.replace(before,after);
 }
 edits.set(file,{file,text,original});
}
const backups=resolve('work/pi-background-sdk-original');
for(const [file,edit] of edits)if(edit.text===edit.original)edits.delete(file);
for(const {file,text,original} of edits.values()){const backup=join(backups,file);await mkdir(dirname(backup),{recursive:true});await writeFile(backup,original,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});await writeFile(sourcePath(file),text);}
console.log(`Pi 1.1.0 background bridge ready (${edits.size} files updated)`);
