import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const script=new URL('../clients/tauri/scripts/package-desktop.mjs',import.meta.url);
test('production without signing references fails before building or uploading',()=>{
 const env={...process.env};delete env.APPLE_SIGNING_IDENTITY;delete env.PIBOT_NOTARY_PROFILE;
 const result=spawnSync(process.execPath,[script.pathname,'production'],{env,encoding:'utf8'});
 assert.equal(result.status,1);assert.match(result.stderr,process.platform==='darwin'&&process.arch==='arm64'?/Production blocked.*No signing or upload attempted/:/supports macOS arm64 only/);assert.doesNotMatch(result.stdout,/Compiling|Created/);
});
test('preview and production use isolated application identities',()=>{
 const read=(name:string)=>JSON.parse(readFileSync(new URL('../clients/tauri/src-tauri/'+name,import.meta.url),'utf8'));
 const preview=read('tauri.preview.conf.json'),prod=read('tauri.production.conf.json');
 assert.notEqual(preview.identifier,prod.identifier);assert.equal(preview.identifier,'dev.pibot.desktop.preview');assert.equal(preview.bundle.macOS.signingIdentity,'-');
});
