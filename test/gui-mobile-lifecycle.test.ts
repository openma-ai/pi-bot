import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntimeRestoration} from '../src/gui/runtime-restoration.ts';
import {isComposerSubmit,resizeComposerTextarea} from '../src/gui/composer-keyboard.ts';
function storage() {
 const values=new Map([['pibo.lastConnection','saved'],['pibo.restoreEnabled','1']]);
 return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
}
const profile={id:'saved',name:'Demo',mode:'direct'};
test('automatic recovery failure remains stable until explicit successful reconnect',()=>{
 const saved=storage(),r=createRuntimeRestoration(saved);
 assert.equal(r.candidate({profiles:[profile]}),profile);
 r.failed(new Error('unreachable'));
 assert.equal(r.candidate({profiles:[profile]}),null);
 assert.equal(r.display([profile])?.name,'Demo');
 r.manual();r.connected(profile);
 assert.equal(r.candidate({profiles:[profile]}),profile);
 assert.equal(saved.getItem('pibo.restoreEnabled'),'1');
});
test('cancel recovery prevents a later automatic attempt without erasing last identity',()=>{
 const saved=storage(),r=createRuntimeRestoration(saved);r.disable();
 assert.equal(r.candidate({profiles:[profile]}),null);
 assert.equal(r.display([profile]),null);
 assert.equal(saved.getItem('pibo.lastConnection'),'saved');
});
test('restoring a draft measured while hidden never sets a zero-height composer',()=>{
 const input={style:{height:'',overflowY:''},scrollHeight:0} as HTMLTextAreaElement;
 resizeComposerTextarea(input,()=> '160px');assert.equal(input.style.height,'44px');
 Object.assign(input,{scrollHeight:116});resizeComposerTextarea(input,()=> '160px');
 assert.equal(input.style.height,'116px');assert.equal(input.style.overflowY,'hidden');
 Object.assign(input,{scrollHeight:240});resizeComposerTextarea(input,()=> '100px');
 assert.equal(input.style.height,'100px');assert.equal(input.style.overflowY,'auto');
});
test('Chinese IME and Shift+Enter never submit chat; plain Enter submits',()=>{
 assert.equal(isComposerSubmit({key:'Enter',nativeEvent:{isComposing:true}}),false);
 assert.equal(isComposerSubmit({key:'Enter',keyCode:229}),false);
 assert.equal(isComposerSubmit({key:'Enter',shiftKey:true}),false);
 assert.equal(isComposerSubmit({key:'Enter'}),true);
});

test('builtin restore is opt-in and one failed start never loops',()=>{
 const saved=storage(),r=createRuntimeRestoration(saved),builtin={id:'builtin',name:'本机',mode:'builtin'};
 assert.equal(r.candidate({profiles:[builtin]}),null);
 r.connected(builtin);
 assert.equal(r.candidate({profiles:[builtin]}),builtin);
 r.failed(Error('missing packaged runtime'));
 assert.equal(r.candidate({profiles:[builtin]}),null);
 r.disable();assert.equal(r.candidate({profiles:[builtin]}),null);
});
