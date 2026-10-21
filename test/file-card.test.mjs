import test from 'node:test';import assert from 'node:assert/strict';
import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {FileCards} from '../src/gui/FileCards.jsx';
test('file cards render safe metadata and a download action, never active attachment markup',()=>{
 const html=renderToStaticMarkup(React.createElement(FileCards,{files:[{id:'a',name:'<script>alert(1)</script>.html',mime:'text/html',size:123}],api:{},scope:{botId:'bot'}}));
 assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/下载文件/);assert.match(html,/text\/html/);
});
