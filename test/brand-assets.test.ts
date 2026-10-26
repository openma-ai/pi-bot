import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
function png(path:string){const b=readFileSync(path);assert.equal(b.subarray(0,8).toString('hex'),'89504e470d0a1a0a');const chunks:string[]=[];for(let n=8;n<b.length;){const size=b.readUInt32BE(n);chunks.push(b.toString('ascii',n+4,n+8));n+=12+size;}return {width:b.readUInt32BE(16),height:b.readUInt32BE(20),color:b[25],chunks};}
test('approved no-eye coral pi source is retained byte-for-byte',()=>{
 const source=readFileSync(join(root,'assets/brand/pibo-approved-source.png'));
 assert.equal(createHash('sha256').update(source).digest('hex'),'4b2bdb034b7c0c013300a0b995f3837b69d51e71212653591f8135ad4a014235');
 const metadata=JSON.parse(readFileSync(join(root,'assets/brand/provenance.json'),'utf8'));assert.equal(metadata.library_file_id,'libfile_cae2cb5f50888191a7232fa5b60af9e7');
});
test('all iPhone, iPad and App Store slots have exact pixel sizes and no transparency',()=>{
 const folder=join(root,'clients/tauri/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset');
 const manifest=JSON.parse(readFileSync(join(folder,'Contents.json'),'utf8'));
 assert.equal(manifest.images.length,18);
 for(const item of manifest.images){const expected=Number(item.size.split('x')[0])*Number(item.scale.replace('x',''));const image=png(join(folder,item.filename));assert.equal(image.width,expected);assert.equal(image.height,expected);assert.equal(image.color,2);assert.ok(!image.chunks.includes('tRNS'));}
});
test('desktop icon manifest resolves to real PNG and complete ICNS assets',()=>{
 const dir=join(root,'clients/tauri/src-tauri');const config=JSON.parse(readFileSync(join(dir,'tauri.conf.json'),'utf8'));
 for(const path of config.bundle.icon)assert.ok(existsSync(join(dir,path)),path);
 const icon=readFileSync(join(dir,'icons/icon.icns'));assert.equal(icon.toString('ascii',0,4),'icns');assert.equal(icon.readUInt32BE(4),icon.length);
 for(const [path,size] of [['icons/32x32.png',32],['icons/128x128.png',128],['icons/128x128@2x.png',256]] as const){const image=png(join(dir,path));assert.equal(image.width,size);assert.equal(image.height,size);assert.equal(image.color,6);}
 assert.equal(png(join(root,'src/gui/assets/pibo-logo.png')).width,256);
});
