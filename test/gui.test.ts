import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGuiMessage } from '../src/gui-server.ts';
test('GUI rejects empty, oversized and unknown bot messages', () => {
    assert.throws(() => validateGuiMessage({
        to: 'a', text: ' '
    }, ['a']));
    assert.throws(() => validateGuiMessage({
        to: 'b', text: 'hello'
    }, ['a']));
    assert.throws(() => validateGuiMessage({
        to: 'a', text: 'x'.repeat(20001)
    }, ['a']));
    assert.deepEqual(validateGuiMessage({
        to: 'a', text: ' hello '
    }, ['a']), {
        to: 'a', text: 'hello'
    });
});
import { startGui } from '../src/gui-server.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
test('GUI persists routed messages and rejects untrusted writes', async () => {
    const dir = await mkdtemp(resolve('work/gui/test-'));
    process.env.PI_BOT_DIR = dir;
    process.env.PI_BOT_GUI_PORT = '0';
    const host = await startGui({
        factory: async (_bot, host) => ({
            async run(e) {
                host.sendMessage(e, 'test result', 'reply:' + e.id);
            }, async close() {
            }
        })
    });
    try {
        const url = `http://127.0.0.1:${(host.server.address() as {
            port: number;
        }).port}`;
        let state = await (await fetch(url + '/api/state')).json() as any;
        const to = state.bots[0].id;
        assert.equal((await fetch(url + '/api/message', {
            method: 'POST', body: JSON.stringify({
                to, text: 'test'
            })
        })).status, 403);
        const response = await fetch(url + '/api/message', {
            method: 'POST', headers: {
                'Content-Type': 'application/json', 'X-Gui-Token': state.token
            }, body: JSON.stringify({
                to, text: 'hello'
            })
        });
        assert.equal(response.status, 200);
        await host.runtime.idle();
        await host.runtime.deliver(async () => {
        });
        state = await (await fetch(url + '/api/state')).json() as any;
        assert.equal(state.messages.length, 2);
        assert.equal(state.messages[0].botId, to);
        assert.equal(state.messages[1].status, 'delivered');
        const groupBot = host.runtime.createBot('group-bot', '', 'group-a');
        const routed = await fetch(url + '/api/message', {
            method: 'POST', headers: {
                'Content-Type': 'application/json', 'X-Gui-Token': state.token
            }, body: JSON.stringify({
                to: groupBot.id, text: 'group task', key: 'group-task'
            })
        });
        assert.equal(routed.status, 200);
        const routedEnvelope = await routed.json() as any;
        assert.equal(routedEnvelope.route.channelId, 'group-a');
        await host.runtime.idle();
        await host.runtime.deliver(async () => {
        });
        const routedAgain = await fetch(url + '/api/message', {
            method: 'POST', headers: {
                'Content-Type': 'application/json', 'X-Gui-Token': state.token
            }, body: JSON.stringify({
                to: groupBot.id, text: 'group task', key: 'group-task'
            })
        });
        assert.equal((await routedAgain.json() as any).id, routedEnvelope.id);
        const post = async (path: string, body: unknown) => fetch(url + '/api/' + path, {
            method: 'POST', headers: {
                'Content-Type': 'application/json', 'X-Gui-Token': state.token
            }, body: JSON.stringify(body)
        });
        const created = await post('routine/create', {
            botId: to, kind: 'schedule', prompt: 'future task', at: Date.now() + 60000, timezone: 'Asia/Shanghai'
        });
        assert.equal(created.status, 200);
        const routine = await created.json() as any;
        assert.equal((await post('routine/action', {
            botId: to, kind: 'schedule', id: routine.id, action: 'pause'
        })).status, 200);
        assert.equal(host.proactive.listSchedules(to)[0].state, 'paused');
        assert.equal((await post('routine/action', {
            botId: to, kind: 'schedule', id: routine.id, action: 'resume'
        })).status, 200);
        assert.equal(host.proactive.listSchedules(to)[0].state, 'active');
        assert.equal((await post('routine/action', {
            botId: 'other', kind: 'schedule', id: routine.id, action: 'cancel'
        })).status, 400);
        assert.equal((await post('routine/create', {
            botId: to, kind: 'schedule', prompt: 'bad', at: 0
        })).status, 400);
        const mon = await post('routine/create', {
            botId: to, kind: 'monitor', prompt: 'report file changes', detector: 'file', intervalMs: 1000, deadline: Date.now() + 60000
        });
        assert.equal(mon.status, 200);
        const monitor = await mon.json() as any;
        assert.equal((await post('routine/action', {
            botId: to, kind: 'monitor', id: monitor.id, action: 'enable'
        })).status, 400);
        assert.equal((await post('routine/action', {
            botId: to, kind: 'monitor', id: monitor.id, action: 'dry-run'
        })).status, 200);
        assert.equal((await post('routine/action', {
            botId: to, kind: 'monitor', id: monitor.id, action: 'enable'
        })).status, 200);
        assert.equal((await post('routine/action', {
            botId: to, kind: 'monitor', id: monitor.id, action: 'pause'
        })).status, 200);
        assert.equal(host.proactive.listMonitors(to)[0].enabled, false);
        assert.equal((await post('routine/action', {
            botId: to, kind: 'monitor', id: monitor.id, action: 'cancel'
        })).status, 200);
    }
    finally {
        await host.close();
        delete process.env.PI_BOT_DIR;
        delete process.env.PI_BOT_GUI_PORT;
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
test('groups and bot-to-bot conversations preserve membership and channel isolation', async () => {
    const dir = await mkdtemp(resolve('work/gui/groups-'));
    process.env.PI_BOT_DIR = dir;
    process.env.PI_BOT_GUI_PORT = '0';
    const host = await startGui({
        factory: async (_bot, rt) => ({
            async run(e) {
                if (e.kind === 'user' && e.to === _bot.id && _bot.name === 'worker')
                    return;
                else if (e.kind === 'user' && e.text.startsWith('delegate:'))
                    rt.sendToBot(e, e.text.slice(9), 'peer work', 'peer:' + e.id);
                else if (e.kind === 'bot')
                    rt.sendMessage(e, 'peer result', 'result:' + e.id);
                else
                    rt.sendMessage(e, 'group result', 'reply:' + e.id);
            }, async close() {
            }
        })
    });
    try {
        const url = `http://127.0.0.1:${(host.server.address() as {
            port: number;
        }).port}`;
        const state = await (await fetch(url + '/api/state')).json() as any;
        const post = async (path: string, body: unknown) => fetch(url + '/api/' + path, {
            method: 'POST', headers: {
                'Content-Type': 'application/json', 'X-Gui-Token': state.token
            }, body: JSON.stringify(body)
        });
        const a = host.runtime.listBots()[0], b = host.runtime.createBot('worker'), c = host.runtime.createBot('outsider');
        const create = await post('group', {
            name: 'team', memberIds: [a.id, b.id]
        });
        assert.equal(create.status, 200);
        const group = await create.json() as any;
        assert.equal((await post('message', {
            to: c.id, groupId: group.id, text: 'forbidden'
        })).status, 400);
        const groupMessage = await post('message', {
            to: a.id, groupId: group.id, text: 'delegate:' + b.id, key: 'group-root'
        });
        assert.equal(groupMessage.status, 200);
        await host.runtime.idle();
        await host.runtime.deliver(async () => {
        });
        const s = await (await fetch(url + '/api/state')).json() as any;
        assert.equal(s.groups.length, 1);
        assert.equal(s.groupMessages.filter((m: any) => m.sourceKind === 'user').length, 1);
        assert.equal(s.messages.filter((m: any) => m.sourceKind === 'user' && m.channelId === group.id).length, 2);
        const peer = s.messages.find((m: any) => m.sourceKind === 'bot');
        assert.equal(peer.channelId, group.id);
        assert.equal(peer.sender, a.id);
        assert.equal(peer.recipient, b.id);
        assert.equal(peer.deliveryTarget, 'direct');
        const output = s.messages.find((m: any) => m.direction === 'outbound' && m.text === 'peer result');
        assert.equal(output.channelId, group.id);
        const other = await (await post('group', {
            name: 'another', memberIds: [a.id, c.id]
        })).json() as any;
        assert.throws(() => host.runtime.sendToBot(host.runtime.store.get<import('../src/store.ts').Envelope>('inbox', peer.messageId)!, c.id, 'leak', 'cross-group'), /channel/i);
        assert.equal((await post('message', {
            to: a.id, groupId: other.id, text: 'second group'
        })).status, 200);
        await host.runtime.idle();
        assert.equal(host.runtime.store.list<import('../src/store.ts').Envelope>('inbox').filter(e => e.kind === 'bot' && e.to === c.id).length, 0);
        assert.equal((await post('group', {
            name: 'bad', memberIds: [a.id, 'missing']
        })).status, 400);
    }
    finally {
        await host.close();
        delete process.env.PI_BOT_DIR;
        delete process.env.PI_BOT_GUI_PORT;
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
import { groupMentions } from '../src/group-mentions.ts';
test('mentions change attention, not group visibility; quotes and code do not address bots', () => {
    const members = [{
            id: 'a', name: '甲'
        }, {
            id: 'b', name: '乙'
        }];
    assert.deepEqual(groupMentions('@甲 做事', members), {
        ids: ['a'], all: false
    });
    assert.deepEqual(groupMentions('@全体成员 各自回复', members), {
        ids: ['a', 'b'], all: true
    });
    assert.deepEqual(groupMentions('`@甲`\n> @乙\n```\n@全体成员\n```', members), {
        ids: [], all: false
    });
    assert.throws(() => groupMentions('@外人 做事', members));
});
test('group @ and @all keep one public message with delivery to every member', async () => {
    const dir = await mkdtemp(resolve('work/gui/mentions-'));
    process.env.PI_BOT_DIR = dir;
    process.env.PI_BOT_GUI_PORT = '0';
    const scopes: string[] = [];
    const host = await startGui({
        factory: async (_bot, _rt, scope) => {
            scopes.push(scope!);
            return {
                async run() {
                }, async close() {
                }
            };
        }
    });
    try {
        const url = `http://127.0.0.1:${(host.server.address() as {
            port: number;
        }).port}`;
        const state = await (await fetch(url + '/api/state')).json() as any;
        const post = async (path: string, body: unknown) => fetch(url + '/api/' + path, {
            method: 'POST', headers: {
                'Content-Type': 'application/json', 'X-Gui-Token': state.token
            }, body: JSON.stringify(body)
        });
        const a = host.runtime.listBots()[0], b = host.runtime.createBot('乙');
        const group = host.runtime.createGroup('room', [a.id, b.id]);
        const sent = await (await post('message', {
            to: a.id, groupId: group.id, text: `@${a.name} 做事`, key: 'named'
        })).json() as any;
        assert.equal(sent.deliveries.length, 2);
        assert.equal(sent.deliveries.find((d: any) => d.to === a.id).groupAttention, 'mention');
        assert.equal(sent.deliveries.find((d: any) => d.to === b.id).groupAttention, 'normal');
        await host.runtime.idle();
        await post('message', {
            to: a.id, groupId: group.id, text: '@全体成员 看一下', key: 'all'
        });
        await host.runtime.idle();
        const again = await post('message', {
            to: a.id, groupId: group.id, text: '@全体成员 看一下', key: 'all'
        });
        assert.equal(again.status, 200);
        await host.runtime.idle();
        const s = await (await fetch(url + '/api/state')).json() as any;
        assert.equal(s.groupMessages.filter((m: any) => m.sourceKind === 'user').length, 2);
        assert.equal(s.messages.filter((m: any) => m.channelId === group.id && m.sourceKind === 'user').length, 4);
        assert.equal(host.trigger.inspect().length, 4);
        assert.ok(host.trigger.inspect().every(r => r.state === 'completed'));
        const all = s.messages.filter((m: any) => m.text === '@全体成员 看一下');
        assert.ok(all.every((m: any) => m.groupAttention === 'mention' && m.mentions.length === 2));
        assert.equal((await post('message', {
            to: a.id, groupId: group.id, text: '@外人 做事'
        })).status, 400);
        const other = host.runtime.createGroup('other', [a.id, b.id]);
        await post('message', {
            to: a.id, groupId: other.id, text: 'normal', key: 'other'
        });
        await host.runtime.idle();
        assert.equal(new Set(scopes).size, 2);
    }
    finally {
        await host.close();
        delete process.env.PI_BOT_DIR;
        delete process.env.PI_BOT_GUI_PORT;
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
test('host review reconciles delivered results and resumes only verified pre-stream failures', async () => {
    const dir = await mkdtemp(resolve('work/gui/review-'));
    process.env.PI_BOT_DIR = dir;
    process.env.PI_BOT_GUI_PORT = '0';
    let runs = 0;
    const host = await startGui({
        factory: async (_bot, rt) => ({
            async run(e) {
                runs++;
                rt.sendMessage(e, 'review result', 'reply:' + e.id);
            }, async close() {
            }
        })
    });
    try {
        const url = `http://127.0.0.1:${(host.server.address() as {
            port: number;
        }).port}`, s = await (await fetch(url + '/api/state')).json() as any;
        const post = async (id: string) => fetch(url + '/api/reconcile', {
            method: 'POST', headers: {
                'Content-Type': 'application/json', 'X-Gui-Token': s.token
            }, body: JSON.stringify({
                id
            })
        });
        const bot = host.runtime.listBots()[0], e = host.runtime.accept({
            to: bot.id, text: 'first', key: 'first'
        });
        await host.runtime.idle();
        await host.runtime.deliver(async () => {
        });
        host.runtime.store.put('inbox', {
            ...host.runtime.store.get<import('../src/store.ts').Envelope>('inbox', e.id)!, state: 'uncertain'
        });
        assert.equal((await post(e.id)).status, 200);
        assert.equal(runs, 1);
        const recover: import('../src/store.ts').Envelope = {
            id: 'safe-recover', from: 'user', to: bot.id, kind: 'user', text: 'second', key: 'second', taskId: 'second', replyTo: null, hop: 0, state: 'uncertain', createdAt: Date.now(), error: 'Error: Provider request refused or failed before streaming'
        };
        host.runtime.store.put('inbox', recover);
        assert.equal((await post(recover.id)).status, 200);
        await host.runtime.idle();
        assert.equal(runs, 2);
        assert.ok(host.trigger.inspect().some(r => r.item.id === recover.id));
        host.runtime.store.put('inbox', {
            ...recover, id: 'unsafe', key: 'unsafe', taskId: 'unsafe', consumedAt: Date.now()
        });
        assert.equal((await post('unsafe')).status, 400);
    }
    finally {
        await host.close();
        delete process.env.PI_BOT_DIR;
        delete process.env.PI_BOT_GUI_PORT;
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
