import test from 'node:test';
import assert from 'node:assert/strict';
import { configureNativeViewport } from '../src/gui/native-viewport.ts';
function fixture() {
 const viewport={content:'width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content'};
 const doc={querySelector:()=>viewport,documentElement:{dataset:{} as Record<string,string|undefined>}};
 return {viewport,doc};
}
test('native iPhone keeps safe areas/keyboard policy and scale 1 idempotently',()=>{
 const {viewport,doc}=fixture();const nav={userAgent:'iPhone',platform:'iPhone',maxTouchPoints:5};
 configureNativeViewport(doc,nav);const first=viewport.content;configureNativeViewport(doc,nav);
 assert.equal(viewport.content,first);assert.match(first,/viewport-fit=cover/);assert.match(first,/interactive-widget=resizes-content/);
 assert.match(first,/maximum-scale=1/);assert.match(first,/user-scalable=no/);assert.equal(doc.documentElement.dataset.nativeIos,'true');
});
test('native iPad desktop user agent is covered; desktop/Android unchanged',()=>{
 const ipad=fixture();configureNativeViewport(ipad.doc,{userAgent:'Macintosh',platform:'MacIntel',maxTouchPoints:5});assert.equal(ipad.doc.documentElement.dataset.nativeIos,'true');
 for (const nav of [{userAgent:'Macintosh',platform:'MacIntel',maxTouchPoints:0},{userAgent:'Android',platform:'Linux',maxTouchPoints:5}]){
  const {viewport,doc}=fixture();const before=viewport.content;configureNativeViewport(doc,nav);assert.equal(viewport.content,before);assert.equal(doc.documentElement.dataset.nativeIos,undefined);
 }
});
