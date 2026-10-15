import test from 'node:test';
import assert from 'node:assert/strict';
import { identityColor, conversationPalette, contrastRatio, defaultIdentityColors } from '../src/gui/identity-color.ts';
test('outgoing bubble follows the same resolved identity color, including custom and missing values', () => {
  for (const id of ['teal-bot','purple-bot','orange-bot']) assert.equal(conversationPalette('chat',id).background,identityColor(id));
  const avatar={color:'#ABCDEF'}; assert.equal(conversationPalette('chat','bot',avatar).background,'#abcdef'); assert.equal(avatar.color,'#ABCDEF');
  assert.equal(identityColor('bot',{color:'#abc'}),'#aabbcc');
  assert.equal(identityColor('bot',{color:'url(secret)'}),identityColor('bot'));
  assert.equal(identityColor('',null),'#d5d5d5');
  assert.notEqual(conversationPalette('chat','a',{color:'#48b39f'}).background,conversationPalette('chat','b',{color:'#9a7ce0'}).background);
});
test('group colors are neutral regardless of any member identity', () => {
  assert.deepEqual(conversationPalette('group','a',{color:'#ff0000'}),conversationPalette('group','b',{color:'#0000ff'}));
  assert.equal(conversationPalette('group').background,'#dededc');
});
test('normal text contrast remains at least WCAG AA for defaults and arbitrary dark/light custom colors', () => {
  const colors=[...defaultIdentityColors,'#000000','#ffffff','#808080','#767676','#00ff00','#ff00ff'];
  for(let i=0;i<4096;i++)colors.push('#'+((i*104729)%0x1000000).toString(16).padStart(6,'0'));
  for(const color of colors){const p=conversationPalette('chat','bot',{color});assert.ok(contrastRatio(p.background,p.foreground)>=4.5,color);}
  const group=conversationPalette('group');assert.ok(contrastRatio(group.background,group.foreground)>=4.5);
});
