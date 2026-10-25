import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {BotRoutineStatus,RoutineStatus} from '../src/gui/RoutineStatus.jsx';

const render=(component,props)=>renderToStaticMarkup(React.createElement(component,props));
test('agent-created schedules and monitors remain visible without client configuration controls',()=>{
 const proactive={schedules:[{id:'s',state:'active',prompt:'agent daily report',nextFire:1800000000000,intervalMs:3600000}],monitors:[{id:'m',state:'paused',prompt:'agent file watch',detector:'file:reports/status.txt',deadline:1800000000000,intervalMs:60000,enabled:false,dryRunVerified:true,lastDecision:'silent'}]};
 const before=structuredClone(proactive);const html=render(BotRoutineStatus,{proactive});
 assert.match(html,/agent daily report/);assert.match(html,/agent file watch/);assert.match(html,/运行中/);assert.match(html,/已暂停/);assert.match(html,/reports\/status.txt/);assert.match(html,/无变化/);
 assert.doesNotMatch(html,/<(?:button|input|select|textarea)\b|role="(?:switch|button)"|新建|创建第一个|datetime-local/);
 assert.deepEqual(proactive,before,'viewing must not alter agent-owned routine data');
});
test('empty routine sections show status without creation guidance',()=>{
 const html=render(BotRoutineStatus,{});assert.match(html,/还没有定时任务/);assert.match(html,/还没有监控/);assert.doesNotMatch(html,/<button\b|新建|创建|分钟后|执行时间/);
});
test('completed schedule and monitor failure details remain readable',()=>{
 const schedule=render(RoutineStatus,{kind:'schedule',routine:{state:'completed',prompt:'finished report',nextFire:1800000000000}});assert.match(schedule,/已触发/);assert.match(schedule,/finished report/);
 const monitor=render(RoutineStatus,{kind:'monitor',watchFile:'watch.txt',routine:{state:'active',prompt:'watch',enabled:true,detector:'file',intervalMs:60000,deadline:1800000000000,lastDecision:'error',error:'synthetic check failure'}});assert.match(monitor,/已启用/);assert.match(monitor,/检查失败/);assert.match(monitor,/synthetic check failure/);assert.match(monitor,/watch.txt/);assert.doesNotMatch(monitor,/<button\b|role="switch"/);
});
