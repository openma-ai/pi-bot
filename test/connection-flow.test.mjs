import test from 'node:test';import assert from 'node:assert/strict';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {ConnectionLanding} from '../src/gui/ConnectionLanding.jsx';import {connectionIssue,usableProfiles} from '../src/gui/connection-flow.js';
const runtime=(remoteOnly=false)=>({status:{profiles:[],remoteOnly,embeddedTailscaleAvailable:true,active:null},connect:async()=>{},refresh:async()=>{}});
test('desktop and iOS landing offer appropriate locations before exposing chat',()=>{
 const desktop=renderToStaticMarkup(React.createElement(ConnectionLanding,{runtime:runtime()}));assert.match(desktop,/这台 Mac/);assert.match(desktop,/远程电脑/);assert.doesNotMatch(desktop,/消息输入|给 bot 发消息/);
 const phone=renderToStaticMarkup(React.createElement(ConnectionLanding,{runtime:runtime(true)}));assert.doesNotMatch(phone,/这台 Mac/);assert.match(phone.match(/<input[^>]*value="remote"[^>]*>/)?.[0]||"",/checked/);assert.match(phone,/通过 Tailscale/);
});
test('connection feedback separates application authorization, unknown remote login and runtime service',()=>{
 assert.equal(connectionIssue('请先授权并准备内嵌节点',{embeddedTailscale:true},'notPrepared').kind,'app-auth');
 const network=connectionIssue('Tailnet 连接失败：检查 ACL',{embeddedTailscale:true},'prepared');assert.equal(network.kind,'network');assert.match(network.detail,/无法确认/);
 assert.equal(connectionIssue('无法连接 runtime',{embeddedTailscale:true},'dialed').kind,'service');
 assert.equal(connectionIssue('此会话没有凭据',{mode:'ssh'}).kind,'credentials');assert.equal(connectionIssue('请核对完整主机公钥',{mode:'ssh'}).kind,'identity');
});
test('placeholder defaults are excluded from reconnect choices without mutating saved profiles',()=>{
 const profiles=[{id:'placeholder',dataDir:'/path/to/existing/pi-bot/data'},{id:'real',dataDir:'/srv/pibo/data'}];assert.deepEqual(usableProfiles(profiles).map(p=>p.id),['real']);assert.equal(profiles.length,2);
});
