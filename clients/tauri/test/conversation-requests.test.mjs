import test from 'node:test';
import assert from 'node:assert/strict';
import { requestsForConversation, safeCredentialPath } from '../../../src/gui/conversation-requests.js';
test('pending actions stay in their own bot/group conversation, including missing thread fallback',()=>{
  const data={groups:[{id:'group'}],threads:[{id:'direct',scope:{channelId:'local:bot'}},{id:'group-thread',scope:{channelId:'group'}}],requests:[
    {id:'q',botId:'bot',threadId:'direct',kind:'question',status:'pending'},
    {id:'a',botId:'bot',threadId:'group-thread',kind:'approval',status:'pending'},
    {id:'c',botId:'bot',threadId:'not-loaded',kind:'credential',status:'pending'},
    {id:'resolved',botId:'bot',threadId:'direct',status:'resolved'},
    {id:'other',botId:'other',threadId:'not-loaded',status:'pending'},
  ]};
  assert.deepEqual(requestsForConversation(data,'bot','bot').map(r=>r.id),['q','c']);
  assert.deepEqual(requestsForConversation(data,'group','group').map(r=>r.id),['a']);
  assert.deepEqual(requestsForConversation(data,'bot','other').map(r=>r.id),['other']);
});
test('secure credential links cannot become arbitrary navigation or path traversal',()=>{
  assert.equal(safeCredentialPath('/credential/fixture_123'),'/credential/fixture_123');
  for(const path of ['https://evil.example','//evil.example','/credential/../rpc','/credential/x?token=secret','/credential/x#secret','/rpc',null]) assert.equal(safeCredentialPath(path),null);
});
