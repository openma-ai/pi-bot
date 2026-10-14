import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiBotDaemon } from '../src/daemon/core/daemon.ts';
import { PiBotClient } from '../src/sdk/client.ts';
import type { SessionFactory } from '../src/pi/host.ts';
import type { Envelope as Input } from '../src/pi/types.ts';
import { groupMentions } from '../src/daemon/runtime/group-mentions.ts';
async function fixture(factory: SessionFactory) {
    const d = await PiBotDaemon.create({
        dataDir: mkdtempSync(join(tmpdir(), 'pi-protocol-')), factory
    });
    const api = await PiBotClient.connect({
        transport: {
            inProcess: d
        }
    });
    const { bot } = await api.bot.create({
        name: '助手'
    });
    return {
        d, api, bot, close: async () => {
            api.close();
            await d.close();
        }
    };
}
const echo: SessionFactory = async (_bot, host) => ({
    run: async (e) => {
        host.sendMessage(e, 'test result', 'reply:' + e.id);
    }, close: async () => {
    }
});
test('protocol rejects empty, oversized and unknown bot input', async () => {
    const h = await fixture(echo);
    try {
        await assert.rejects(h.api.turn.start({
            botId: h.bot.id, text: ' ', key: 'a'
        }), (e: any) => e.reason === 'invalidParams');
        await assert.rejects(h.api.turn.start({
            botId: 'missing', text: 'hello', key: 'b'
        }), (e: any) => e.reason === 'notFound');
        await assert.rejects(h.api.turn.start({
            botId: h.bot.id, text: 'x'.repeat(64001), key: 'c'
        }), (e: any) => e.reason === 'invalidParams');
    }
    finally {
        await h.close();
    }
});
test('protocol preserves routed delivery, routine state and monitor dry-run requirements', async () => {
    const h = await fixture(echo);
    const { api, d, bot } = h;
    try {
        await api.turn.start({
            botId: bot.id, text: 'hello', key: 'hello'
        });
        await d.runtime.idle();
        await d.runtime.deliver(async () => {
        });
        let state: any = await api.daemon.snapshot({});
        assert.equal(state.messages.length, 2);
        assert.equal(state.messages[1].status, 'delivered');
        const { bot: routed } = await api.bot.create({
            name: 'group-bot', channelId: 'group-a'
        });
        const one = await api.turn.start({
            botId: routed.id, text: 'group task', key: 'routed'
        });
        const two = await api.turn.start({
            botId: routed.id, text: 'group task', key: 'routed'
        });
        assert.equal(one.inputId, two.inputId);
        assert.equal(d.runtime.store.get<Input>('inbox', one.inputId)?.route?.channelId, 'group-a');
        await d.runtime.idle();
        const { routine } = await api.routine.create({
            kind: 'schedule', botId: bot.id, prompt: 'future task', at: Date.now() + 60000, timezone: 'Asia/Shanghai'
        });
        await api.routine.pause({
            routineId: routine.id
        });
        assert.equal(d.proactive.listSchedules(bot.id)[0].state, 'paused');
        await api.routine.resume({
            routineId: routine.id
        });
        assert.equal(d.proactive.listSchedules(bot.id)[0].state, 'active');
        await assert.rejects(api.routine.cancel({
            routineId: 'schedule:missing'
        }), (e: any) => e.reason === 'notFound');
        await assert.rejects(api.routine.create({
            kind: 'schedule', botId: bot.id, prompt: 'bad', at: 0, timezone: 'Asia/Shanghai'
        }), (e: any) => e.reason === 'invalidParams');
        const { routine: mon } = await api.routine.create({
            kind: 'monitor', botId: bot.id, prompt: 'file changes', intervalMs: 1000, deadline: Date.now() + 60000
        });
        await assert.rejects(api.routine.enable({
            routineId: mon.id
        }), (e: any) => e.reason === 'invalidRequest');
        await api.routine.dryRun({
            routineId: mon.id
        });
        await api.routine.enable({
            routineId: mon.id
        });
        await api.routine.pause({
            routineId: mon.id
        });
        assert.equal(d.proactive.listMonitors(bot.id)[0].enabled, false);
        await api.routine.cancel({
            routineId: mon.id
        });
    }
    finally {
        await h.close();
    }
});
test('groups and native bot-to-bot effects preserve membership and channel isolation', async () => {
    const h = await fixture(async (bot, rt) => ({
        run: async (e) => {
            if (e.kind === 'user' && bot.name === 'worker')
                return;
            if (e.kind === 'user' && e.text.startsWith('delegate:'))
                rt.sendToBot(e, e.text.slice(9), 'peer work', 'peer:' + e.id);
            else
                rt.sendMessage(e, e.kind === 'bot' ? 'peer result' : 'group result', 'reply:' + e.id);
        }, close: async () => {
        }
    }));
    const { api, d, bot: a } = h;
    try {
        const { bot: b } = await api.bot.create({
            name: 'worker'
        }), { bot: c } = await api.bot.create({
            name: 'outsider'
        });
        const { group } = await api.group.create({
            name: 'team', memberIds: [a.id, b.id]
        });
        await assert.rejects(api.turn.start({
            botId: c.id, groupId: group.id, text: 'forbidden', key: 'bad'
        }), (e: any) => e.reason === 'forbidden');
        await api.turn.start({
            botId: a.id, groupId: group.id, text: 'delegate:' + b.id, key: 'root'
        });
        await d.runtime.idle();
        await d.runtime.deliver(async () => {
        });
        const s: any = await api.daemon.snapshot({});
        assert.equal(s.groupMessages.filter((m: any) => m.sourceKind === 'user').length, 1);
        assert.equal(s.messages.filter((m: any) => m.sourceKind === 'user' && m.channelId === group.id).length, 2);
        const peer = s.messages.find((m: any) => m.sourceKind === 'bot');
        assert.equal(peer.channelId, group.id);
        assert.equal(peer.sender, a.id);
        assert.equal(peer.recipient, b.id);
        assert.equal(peer.deliveryTarget, 'direct');
        assert.equal(s.messages.find((m: any) => m.text === 'peer result').channelId, group.id);
        const { group: other } = await api.group.create({
            name: 'other', memberIds: [a.id, c.id]
        });
        assert.throws(() => d.runtime.sendToBot(d.runtime.store.get<Input>('inbox', peer.messageId)!, c.id, 'leak', 'leak'), /channel/i);
        await api.turn.start({
            botId: a.id, groupId: other.id, text: 'second group', key: 'second'
        });
        await d.runtime.idle();
        assert.equal(d.runtime.store.list<Input>('inbox').filter(e => e.kind === 'bot' && e.to === c.id).length, 0);
        await assert.rejects(api.group.create({
            name: 'bad', memberIds: [a.id, 'missing']
        }));
    }
    finally {
        await h.close();
    }
});
test('mentions prioritize attention while preserving shared visibility and ignoring quotations', () => {
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
test('group @ and @all preserve one shared record and a durable delivery per member', async () => {
    const scopes: string[] = [];
    const h = await fixture(async (_b, _r, scope) => {
        scopes.push(scope!);
        return {
            run: async () => {
            }, close: async () => {
            }
        };
    });
    const { api, d, bot: a } = h;
    try {
        const { bot: b } = await api.bot.create({
            name: '乙'
        });
        const { group } = await api.group.create({
            name: 'room', memberIds: [a.id, b.id]
        });
        const sent = await api.turn.start({
            botId: a.id, groupId: group.id, text: '@' + a.name + ' 做事', key: 'named'
        });
        assert.equal(sent.inputIds?.length, 2);
        const named = d.runtime.store.list<Input>('inbox');
        assert.equal(named.find(e => e.to === a.id)?.groupAttention, 'mention');
        assert.equal(named.find(e => e.to === b.id)?.groupAttention, 'normal');
        await d.runtime.idle();
        await api.turn.start({
            botId: a.id, groupId: group.id, text: '@全体成员 看一下', key: 'all'
        });
        await d.runtime.idle();
        await api.turn.start({
            botId: a.id, groupId: group.id, text: '@全体成员 看一下', key: 'all'
        });
        await d.runtime.idle();
        const s: any = await api.daemon.snapshot({});
        assert.equal(s.groupMessages.filter((m: any) => m.sourceKind === 'user').length, 2);
        assert.equal(s.messages.filter((m: any) => m.channelId === group.id && m.sourceKind === 'user').length, 4);
        assert.equal(d.trigger.inspect().length, 4);
        assert.ok(d.trigger.inspect().every(r => r.state === 'completed'));
        assert.ok(s.messages.filter((m: any) => m.text === '@全体成员 看一下').every((m: any) => m.groupAttention === 'mention' && m.mentions.length === 2));
        await assert.rejects(api.turn.start({
            botId: a.id, groupId: group.id, text: '@外人 做事', key: 'outsider'
        }));
        const { group: other } = await api.group.create({
            name: 'other', memberIds: [a.id, b.id]
        });
        await api.turn.start({
            botId: a.id, groupId: other.id, text: 'normal', key: 'other'
        });
        await d.runtime.idle();
        assert.equal(new Set(scopes).size, 2);
    }
    finally {
        await h.close();
    }
});
test('host reconciliation trusts delivered evidence and resumes only verified pre-stream failures', async () => {
    let runs = 0;
    const h = await fixture(async (_b, rt) => ({
        run: async (e) => {
            runs++;
            rt.sendMessage(e, 'review result', 'reply:' + e.id);
        }, close: async () => {
        }
    }));
    const { api, d, bot } = h;
    try {
        const e = d.runtime.accept({
            to: bot.id, text: 'first', key: 'first'
        });
        await d.runtime.idle();
        await d.runtime.deliver(async () => {
        });
        d.runtime.store.put('inbox', {
            ...d.runtime.store.get<Input>('inbox', e.id)!, state: 'uncertain'
        });
        assert.equal((await api.task.reconcile({
            inputId: e.id
        })).outcome, 'processed');
        assert.equal(runs, 1);
        const recover: Input = {
            id: 'safe', from: 'user', to: bot.id, kind: 'user', text: 'second', key: 'second', taskId: 'second', replyTo: null, hop: 0, state: 'uncertain', createdAt: Date.now(), error: 'Error: Provider request refused or failed before streaming'
        };
        d.runtime.store.put('inbox', recover);
        assert.equal((await api.task.reconcile({
            inputId: recover.id
        })).outcome, 'queued');
        await d.runtime.idle();
        assert.equal(runs, 2);
        assert.ok(d.trigger.inspect().some(r => (r.item.body as any).payload.id === recover.id));
        d.runtime.store.put('inbox', {
            ...recover, id: 'unsafe', key: 'unsafe', taskId: 'unsafe', consumedAt: Date.now()
        });
        await assert.rejects(api.task.reconcile({
            inputId: 'unsafe'
        }), (e: any) => e.reason === 'reviewRequired');
    }
    finally {
        await h.close();
    }
});

test("image-guard recovery replays only a proven read-only checkpoint", async () => {
  const h = await fixture(echo);
  try {
    const e = h.d.runtime.accept({
      to: h.bot.id,
      text: "read screenshot",
      key: "vision",
    });
    await h.d.runtime.idle();
    // Inject a screenshot-only checkpoint; real provider execution is reported separately.
    const safe: Input = {
      ...e,
      id: "image-safe",
      key: "image-safe",
      taskId: "image-task",
      state: "uncertain",
      consumedAt: Date.now(),
      resolvedAt: undefined,
      error:
        "ContextBudgetError: Image inputs need a provider-specific context budget. No input or history was truncated.",
    };
    h.d.runtime.store.put("inbox", safe);
    const turn: any = {
      id: "image-turn",
      taskId: safe.taskId,
      botId: h.bot.id,
      inputIds: [safe.id],
      primaryInputId: safe.id,
    };
    h.d.runtime.store.put("turns", turn);
    h.d.runtime.store.put("items", {
      id: "image-call",
      type: "toolCall",
      turnId: turn.id,
      status: "completed",
      tool: "desktop_call",
      args: { kind: "computer", tool: "screenshot", args: {} },
      isError: false,
    });
    assert.equal(
      (await h.api.task.recovery({ inputId: safe.id })).canRetry,
      true,
    );
    assert.equal(
      (await h.api.task.reconcile({ inputId: safe.id })).outcome,
      "queued",
    );
    await h.d.runtime.idle();
    const unsafe = {
      ...safe,
      id: "image-unsafe",
      key: "image-unsafe",
      taskId: "unsafe-task",
    };
    h.d.runtime.store.put("inbox", unsafe);
    h.d.runtime.store.put("turns", {
      ...turn,
      id: "unsafe-turn",
      taskId: unsafe.taskId,
      inputIds: [unsafe.id],
    });
    h.d.runtime.store.put("items", {
      id: "write-call",
      type: "toolCall",
      turnId: "unsafe-turn",
      status: "completed",
      tool: "bash",
      args: { command: "echo effects" },
      isError: false,
    });
    assert.equal(
      (await h.api.task.recovery({ inputId: unsafe.id })).canRetry,
      false,
    );
    h.d.runtime.store.put("inbox", {
      ...unsafe,
      consumedAt: undefined,
      error: "Error: Provider request refused or failed before streaming",
    });
    assert.equal(
      (await h.api.task.recovery({ inputId: unsafe.id })).canRetry,
      false,
    );
    await assert.rejects(
      h.api.task.reconcile({ inputId: unsafe.id }),
      (e: any) => e.reason === "reviewRequired",
    );
  } finally {
    await h.close();
  }
});

test("resuming an already handed-off input reaches Pi again through a new OpenMatter lease", async () => {
  let runs = 0;
  const h = await fixture(async (_b, rt) => ({
    async run(e) {
      runs++;
      if (runs === 1) {
        rt.events?.emit(e.to, {
          type: "toolStarted",
          tool: "desktop_call",
          toolCallId: "read-only",
          args: { kind: "computer", tool: "screenshot", args: {} },
        });
        rt.events?.emit(e.to, {
          type: "toolCompleted",
          toolCallId: "read-only",
          result: { content: [{ type: "text", text: "image fixture" }] },
          isError: false,
        });
        throw Error("Provider request refused or failed before streaming");
      }
      rt.sendMessage(e, "resumed", "resumed");
    },
    async close() {},
  }));
  try {
    const e = h.d.runtime.accept({
      to: h.bot.id,
      text: "resume actual input",
      key: "actual",
    });
    await h.d.runtime.idle();
    assert.equal(runs, 1);
    assert.equal(h.d.trigger.inspect()[0]!.state, "completed");
    await h.api.task.reconcile({ inputId: e.id });
    await h.d.runtime.idle();
    assert.equal(runs, 2);
    assert.equal(
      h.d.runtime.store.get<Input>("inbox", e.id)!.state,
      "processed",
    );
  } finally {
    await h.close();
  }
});

test('paused ingress publishes a scoped service event without requiring a GUI refresh',async()=>{
 const h=await fixture(echo);try{const events:any[]=[];const before=await h.api.daemon.snapshot({});const stop=await h.api.events.subscribe({after:before.seq},e=>events.push(e));
 h.d.trigger.publish({id:'missing-native-input',from:'user',to:h.bot.id,kind:'user',text:'fixture',key:'missing',taskId:'missing',replyTo:null,hop:0,state:'queued',createdAt:Date.now()});h.d.trigger.flush();
 const deadline=Date.now()+3000;while(!events.some(e=>e.method==='daemon/triggerChanged')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
 assert.equal(events.find(e=>e.method==='daemon/triggerChanged')?.params.trigger.halted,true);assert.equal((await h.api.daemon.snapshot({})).trigger?.halted,true);stop();
 }finally{await h.close();}
});
