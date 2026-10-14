import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConversationRoute, conversationHash } from '../../../src/gui/hooks/use-conversation-route.js';
import { togglePinned, conversationKey } from '../../../src/gui/hooks/use-pinned-conversations.js';
test('IM deep links preserve bot/group identifiers and reject malformed routes',()=>{
  for(const kind of ['bot','group']) for(const id of ['bot-a','群聊 / ?', 'a:b'])
    assert.deepEqual(parseConversationRoute(conversationHash(kind,id)),{page:'chat',kind,id});
  for(const hash of ['', '#/conversations','#/chat/other/x','#/chat/bot/%ZZ','#/chat/bot/', '#/chat/bot/a/b'])
    assert.deepEqual(parseConversationRoute(hash),{page:'list'});
});
test('pins allow bots and groups, deduplicate, remove independently and survive JSON persistence',()=>{
  const bot={kind:'bot',id:'same'},group={kind:'group',id:'same'};
  assert.deepEqual(togglePinned([],bot),[conversationKey(bot)]);
  const multiple=togglePinned(togglePinned([],bot),group);
  assert.equal(new Set(multiple).size,2);
  const saved=JSON.parse(JSON.stringify({runtimeA:multiple,runtimeB:[]}));
  assert.deepEqual(saved.runtimeA,multiple);assert.deepEqual(saved.runtimeB,[]);
  assert.deepEqual(togglePinned(saved.runtimeA,bot),[conversationKey(group)]);
  assert.deepEqual(togglePinned(togglePinned(saved.runtimeA,bot),group),[]);
});
