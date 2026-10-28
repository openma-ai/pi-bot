import {test} from 'node:test';
import assert from 'node:assert/strict';
import {piLoginPresentation,piCatalogNote,piProviderConfigured} from '../src/gui/pi-login-presentation.ts';
const browser={id:'synthetic',providerId:'openai',type:'oauth',status:'pending',events:[{type:'auth_url',url:'https://example.invalid/never-open'}],prompt:{type:'manual_code'}};
test('OpenAI callback is a waiting state with optional fallback, not a mandatory secret form',()=>{
 const ui=piLoginPresentation(browser,'local');assert.equal(ui.fallback,true);assert.equal(ui.spinning,true);assert.equal(ui.title,'等待你在浏览器完成登录');assert.match(ui.note!,/无需再填写/);
 assert.match(piLoginPresentation(browser,'remote').note!,/不会自动到达远端/);
 assert.match(piLoginPresentation(browser).note!,/同一台机器/);
});
test('SDK exchange progress, uncertain transport and user choices remain distinct',()=>{
 assert.equal(piLoginPresentation({...browser,events:[...browser.events,{type:'progress'}]}).title,'正在确认授权结果…');
 assert.equal(piLoginPresentation({...browser,uncertain:true}).title,'正在确认登录状态…');
 const select=piLoginPresentation({...browser,events:[],prompt:{type:'select'}});assert.equal(select.spinning,false);assert.equal(select.title,'选择登录方式');
 const secret=piLoginPresentation({...browser,type:'api_key',events:[],prompt:{type:'secret'}});assert.equal(secret.fallback,false);assert.equal(secret.spinning,false);
});
test('Device codes and unrelated required manual prompts are not mistaken for optional loopback fallback',()=>{
 assert.equal(piLoginPresentation({...browser,providerId:'anthropic'}).fallback,false);
 const device=piLoginPresentation({...browser,providerId:'openai-codex',events:[{type:'device_code'}],prompt:undefined});assert.equal(device.fallback,false);assert.equal(device.title,'等待你完成设备码授权');
 assert.equal(piLoginPresentation({...browser,status:'complete'}).spinning,false);
});
test('Model source labels never imply account entitlement, and SDK-configured auth includes environment credentials',()=>{
 assert.match(piCatalogNote(undefined),/未提供目录刷新状态/);assert.match(piCatalogNote({status:'failed'}),/刷新未完成/);assert.match(piCatalogNote({status:'refreshed'}),/不代表账号/);
 assert.equal(piProviderConfigured({credential:null,configured:true}),true);assert.equal(piProviderConfigured({credential:'oauth',configured:false}),false);
});
