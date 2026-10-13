import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BotRuntime } from '../src/runtime.ts';
import { ProactiveService } from '../src/proactive.ts';
import type { Envelope } from '../src/store.ts';
async function fixture(run?: (e: Envelope) => Promise<void>) {
    await mkdir(resolve('work/proactive-tests'), {
        recursive: true
    });
    const dir = await mkdtemp(resolve('work/proactive-tests/case-'));
    const path = join(dir, 'runtime.db');
    const seen: Envelope[] = [];
    const factory = async () => ({
        async run(e: Envelope) {
            seen.push(e);
            await run?.(e);
        }, async close() {
        }
    });
    let runtime = new BotRuntime(path, factory);
    let now = 1000;
    const bot = runtime.createBot('main', '', 'group-a');
    const source = runtime.accept({
        to: bot.id, text: 'watch and remind', key: 'origin', route: {
            channelId: 'group-a', threadId: 'thread-a', senderId: 'alice'
        }
    });
    await runtime.idle();
    return {
        dir, seen, source, get runtime() {
            return runtime;
        }, now: () => now, time: (n: number) => now = n,
        async restart() {
            await runtime.close();
            runtime = new BotRuntime(path, factory);
            return runtime;
        },
        async close() {
            await runtime.close();
            await rm(dir, {
                recursive: true, force: true
            });
        }
    };
}
test('one-shot fire persists identity and inherited group route across restart', async () => {
    const h = await fixture();
    try {
        let service = new ProactiveService(h.runtime, {
            now: h.now
        });
        const s = service.createSchedule(h.source, {
            key: 'reminder', prompt: 'report result', at: 2000, timezone: 'Asia/Shanghai'
        });
        await service.tick();
        assert.equal(h.seen.length, 1);
        h.time(2000);
        await service.tick();
        await h.runtime.idle();
        assert.equal(h.seen.length, 2);
        assert.equal(h.seen[1].kind, 'schedule');
        assert.deepEqual(h.seen[1].route, h.source.route);
        const key = h.seen[1].key;
        service = new ProactiveService(await h.restart(), {
            now: h.now
        });
        await service.tick();
        await h.runtime.idle();
        assert.equal(h.seen.length, 2);
        assert.equal(service.listSchedules(h.source.to)[0].state, 'completed');
        assert.equal(service.listFires(h.source.to)[0].eventKey, key);
        assert.throws(() => service.createSchedule(h.source, {
            key: 'bad', prompt: 'x', at: 3000, timezone: 'Bogus/Zone'
        }), /timezone/i);
        assert.equal(s.revision, 1);
    }
    finally {
        await h.close();
    }
});
test('catchup is bounded and skipped misfires are auditable', async () => {
    const h = await fixture();
    try {
        const service = new ProactiveService(h.runtime, {
            now: h.now, maxFiresPerTick: 2
        });
        const s = service.createSchedule(h.source, {
            key: 'catchup', prompt: 'report', at: 2000, intervalMs: 1000, timezone: 'America/New_York', misfire: 'catchup', overlap: 'queue'
        });
        h.time(10000);
        await service.tick();
        await h.runtime.idle();
        assert.equal(service.listFires(h.source.to).length, 2);
        assert.equal(service.listSchedules(h.source.to)[0].nextFire, 4000);
        service.cancelSchedule(h.source.to, s.id);
        const skipped = service.createSchedule(h.source, {
            key: 'skip', prompt: 'skip old slots', at: 2000, intervalMs: 1000, timezone: 'UTC', misfire: 'skip'
        });
        await service.tick();
        assert.equal(service.listSchedules(h.source.to).find(x => x.id === skipped.id)?.lastSkip?.reason, 'misfire');
        assert.equal(service.listSchedules(h.source.to).find(x => x.id === skipped.id)?.nextFire, 11000);
    }
    finally {
        await h.close();
    }
});
test('overlap skip preserves one running fire and records skipped period', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => release = r);
    const h = await fixture(async (e) => {
        if (e.kind === 'schedule')
            await gate;
    });
    try {
        const service = new ProactiveService(h.runtime, {
            now: h.now
        });
        const s = service.createSchedule(h.source, {
            key: 'slow', prompt: 'slow task', at: 2000, intervalMs: 1000, timezone: 'UTC', overlap: 'skip'
        });
        h.time(2000);
        await service.tick();
        await new Promise(r => setImmediate(r));
        h.time(3000);
        await service.tick();
        assert.equal(service.listFires(h.source.to).length, 1);
        assert.equal(service.listSchedules(h.source.to).find(x => x.id === s.id)?.lastSkip?.reason, 'overlap');
    }
    finally {
        release();
        await h.close();
    }
});
test('repeated monitor enable preserves fire dedup; cancelled source does not block other schedules', async () => {
    const h = await fixture();
    try {
        const service = new ProactiveService(h.runtime, {
            now: h.now, detectors: {
                changed: async () => ({
                    decision: 'wake', dedupKey: 'x'.repeat(256), payload: 'changed'
                })
            }
        });
        const m = service.createMonitor(h.source, {
            key: 'monitor', detector: 'changed', prompt: 'watch', intervalMs: 1000, deadline: 5000
        });
        await service.dryRunMonitor(h.source.to, m.id);
        service.enableMonitor(h.source.to, m.id);
        await service.tick();
        await h.runtime.idle();
        service.enableMonitor(h.source.to, m.id);
        h.time(2000);
        await service.tick();
        await h.runtime.idle();
        assert.equal(h.seen.filter(e => e.kind === 'monitor').length, 1);
        service.cancelMonitor(h.source.to, m.id);
        service.createSchedule(h.source, {
            key: 'cancelled', prompt: 'old', at: 3000, timezone: 'UTC'
        });
        h.runtime.accept({
            to: h.source.to, taskId: h.source.taskId, key: 'cancel', text: 'cancel', taskControl: 'cancel', route: h.source.route
        });
        await h.runtime.idle();
        const other = h.runtime.accept({
            to: h.source.to, key: 'other', text: 'still valid', route: h.source.route
        });
        await h.runtime.idle();
        service.createSchedule(other, {
            key: 'valid', prompt: 'valid', at: 3000, timezone: 'UTC'
        });
        h.time(3000);
        await service.tick();
        await h.runtime.idle();
        assert.equal(h.seen.filter(e => e.kind === 'schedule').length, 1);
    }
    finally {
        await h.close();
    }
});
test('interval misfire coalesces; cancellation invalidates queued fire before side effects', async () => {
    const h = await fixture();
    try {
        const service = new ProactiveService(h.runtime, {
            now: h.now
        });
        const s = service.createSchedule(h.source, {
            key: 'repeat', prompt: 'check', at: 2000, intervalMs: 1000, timezone: 'UTC', misfire: 'coalesce', overlap: 'skip'
        });
        h.time(10000);
        await service.tick();
        await h.runtime.idle();
        assert.equal(service.listFires(h.source.to).length, 1);
        assert.equal(service.listSchedules(h.source.to)[0].nextFire, 11000);
        service.cancelSchedule(h.source.to, s.id);
        assert.throws(() => h.runtime.sendMessage(h.seen[1], 'stale reminder', 'late-send'), /cancelled/i);
        h.time(12000);
        await service.tick();
        assert.equal(service.listFires(h.source.to).length, 1);
        assert.throws(() => service.cancelSchedule('foreign-bot', s.id), /owner/i);
    }
    finally {
        await h.close();
    }
});
test('background memory proposal needs independent review, intact evidence and snapshot CAS', async () => {
    const h = await fixture();
    try {
        const service = new ProactiveService(h.runtime, {
            now: h.now, workers: {
                memory: {
                    generate: async (evidence) => ({
                        text: 'User wants build notifications', evidenceRefs: evidence.map(e => e.id)
                    }), review: async () => ({
                        approved: true, reason: 'supported by source'
                    })
                }
            }
        });
        const p = service.startBackgroundWork(h.source, {
            kind: 'memory', key: 'prefs', memoryKey: 'notifications', evidenceRefs: [h.source.id]
        });
        await h.runtime.idle();
        assert.equal(service.getProposal(h.source.to, p.id).state, 'approved');
        assert.equal(h.runtime.store.list('outbox').length, 0);
        service.applyMemory(h.source.to, p.id);
        assert.equal(service.getMemory(h.source.to, 'notifications')?.version, 1);
        assert.equal(service.applyMemory(h.source.to, p.id).version, 1); // application replay is idempotent
        const old = service.startBackgroundWork(h.source, {
            kind: 'memory', key: 'old', memoryKey: 'notifications', evidenceRefs: [h.source.id]
        });
        const newer = service.startBackgroundWork(h.source, {
            kind: 'memory', key: 'new', memoryKey: 'notifications', evidenceRefs: [h.source.id]
        });
        await h.runtime.idle();
        service.applyMemory(h.source.to, newer.id);
        assert.throws(() => service.applyMemory(h.source.to, old.id), /snapshot/i);
    }
    finally {
        await h.close();
    }
});
test('research rejects forged evidence and remains bounded without automatic user notification', async () => {
    const h = await fixture();
    try {
        const service = new ProactiveService(h.runtime, {
            now: h.now, workers: {
                research: {
                    generate: async () => ({
                        text: 'unsupported claim', evidenceRefs: ['forged-id']
                    }), review: async () => ({
                        approved: true, reason: 'approval cannot invent evidence'
                    })
                }
            }
        });
        const p = service.startBackgroundWork(h.source, {
            kind: 'research', key: 'research', evidenceRefs: [h.source.id]
        });
        await h.runtime.idle();
        assert.equal(service.getProposal(h.source.to, p.id).state, 'rejected');
        assert.equal(h.runtime.store.list('outbox').length, 0);
        assert.throws(() => service.startBackgroundWork(h.source, {
            kind: 'research', key: 'foreign', evidenceRefs: ['missing']
        }), /evidence/i);
    }
    finally {
        await h.close();
    }
});
test('permission-denied background execution leaves an inspectable terminal proposal', async () => {
    const h = await fixture();
    let generated = 0;
    try {
        h.runtime.options.permission = () => false;
        const service = new ProactiveService(h.runtime, {
            workers: {
                memory: {
                    generate: async (evidence) => {
                        generated++;
                        return {
                            text: 'x', evidenceRefs: evidence.map(e => e.id)
                        };
                    }, review: async () => ({
                        approved: true, reason: 'x'
                    })
                }
            }
        });
        const p = service.startBackgroundWork(h.source, {
            kind: 'memory', key: 'denied', memoryKey: 'prefs', evidenceRefs: [h.source.id]
        });
        await h.runtime.idle();
        assert.equal(generated, 0);
        assert.equal(h.runtime.store.get<{
            state: string;
        }>('proposals', p.id)?.state, 'uncertain');
        assert.equal(service.getProposal(h.source.to, p.id).state, 'uncertain');
    }
    finally {
        await h.close();
    }
});
test('approved research result wakes own inbox once; explicit cancellation prevents late publication', async () => {
    const h = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(r => release = r);
    let held = false;
    try {
        const service = new ProactiveService(h.runtime, {
            now: h.now, workers: {
                research: {
                    generate: async (evidence) => {
                        if (held)
                            await gate;
                        return {
                            text: 'Supported local finding', evidenceRefs: evidence.map(e => e.id)
                        };
                    }, review: async () => ({
                        approved: true, reason: 'reviewed against source'
                    })
                }
            }
        });
        const p = service.startBackgroundWork(h.source, {
            kind: 'research', key: 'research-ok', evidenceRefs: [h.source.id]
        });
        await h.runtime.idle();
        assert.equal(h.seen.filter(e => e.kind === 'research').length, 1);
        const read = service.readProposal(h.source.to, p.id);
        assert.equal(read.consumedAt !== undefined, true);
        assert.equal(h.runtime.store.list('outbox').length, 0);
        held = true;
        const late = service.startBackgroundWork(h.source, {
            kind: 'research', key: 'research-cancel', evidenceRefs: [h.source.id]
        });
        await new Promise(r => setImmediate(r));
        service.cancelBackgroundWork(h.source.to, late.id);
        release();
        await h.runtime.idle();
        assert.equal(service.getProposal(h.source.to, late.id).state, 'cancelled');
        assert.equal(h.seen.filter(e => e.kind === 'research').length, 1);
    }
    finally {
        release();
        await h.close();
    }
});
test('monitor dry-run does not consume cursor; silent costs no model wake; changed event deduplicates', async () => {
    const h = await fixture();
    let changed = false;
    let checks = 0;
    try {
        const service = new ProactiveService(h.runtime, {
            now: h.now, detectors: {
                build: async (input) => {
                    checks++;
                    return changed ? {
                        decision: 'wake', cursor: 'v2', baseline: 'ok', dedupKey: 'build-v2', payload: 'Build passed'
                    } : {
                        decision: 'silent', cursor: 'v1', baseline: 'pending'
                    };
                }
            }
        });
        const m = service.createMonitor(h.source, {
            key: 'build', detector: 'build', prompt: 'notify only build completion', intervalMs: 1000, deadline: 5000
        });
        await service.dryRunMonitor(h.source.to, m.id);
        assert.equal(service.listMonitors(h.source.to)[0].cursor, undefined);
        assert.equal(service.listMonitors(h.source.to)[0].enabled, false);
        service.enableMonitor(h.source.to, m.id);
        await service.tick();
        assert.equal(h.seen.length, 1);
        changed = true;
        h.time(2000);
        await service.tick();
        await h.runtime.idle();
        h.time(3000);
        await service.tick();
        await h.runtime.idle();
        assert.equal(h.seen.filter(e => e.kind === 'monitor').length, 1);
        assert.equal(service.listMonitors(h.source.to)[0].cursor, 'v2');
        h.time(5000);
        await service.tick();
        await h.runtime.idle();
        assert.equal(service.listMonitors(h.source.to)[0].state, 'expired');
        assert.equal(h.seen.filter(e => e.kind === 'monitor').length, 2); // explicit deadline closure
        assert.equal(checks, 4);
    }
    finally {
        await h.close();
    }
});
test('cancelled monitor discards a late detector result', async () => {
    const h = await fixture();
    let release!: () => void;
    let detects = 0;
    const gate = new Promise<void>(r => release = r);
    try {
        const service = new ProactiveService(h.runtime, {
            now: h.now, detectors: {
                held: async () => {
                    if (detects++ === 0)
                        return {
                            decision: 'silent'
                        };
                    await gate;
                    return {
                        decision: 'wake', dedupKey: 'late', payload: 'old result'
                    };
                }
            }
        });
        const m = service.createMonitor(h.source, {
            key: 'held', detector: 'held', prompt: 'watch', intervalMs: 1000, deadline: 5000
        });
        await service.dryRunMonitor(h.source.to, m.id);
        service.enableMonitor(h.source.to, m.id);
        const tick = service.tick();
        await new Promise(r => setImmediate(r));
        service.cancelMonitor(h.source.to, m.id);
        release();
        await tick;
        await h.runtime.idle();
        assert.equal(h.seen.filter(e => e.kind === 'monitor').length, 0);
    }
    finally {
        release();
        await h.close();
    }
});
test('enable requires successful dry-run; definition conflicts and detector errors retain cursor', async () => {
    const h = await fixture();
    try {
        let error = false;
        const service = new ProactiveService(h.runtime, {
            now: h.now, detectors: {
                check: async () => error ? {
                    decision: 'error', error: 'unavailable', cursor: 'must-not-advance'
                } : {
                    decision: 'silent', cursor: 'initial'
                }
            }
        });
        const input = {
            key: 'checked', detector: 'check', prompt: 'watch', intervalMs: 1000, deadline: 5000
        };
        const m = service.createMonitor(h.source, input);
        assert.throws(() => service.enableMonitor(h.source.to, m.id), /dry.run/i);
        await service.dryRunMonitor(h.source.to, m.id);
        service.enableMonitor(h.source.to, m.id);
        await service.tick();
        error = true;
        h.time(2000);
        await service.tick();
        assert.equal(service.listMonitors(h.source.to)[0].cursor, 'initial');
        assert.throws(() => service.createMonitor(h.source, {
            ...input, prompt: 'different'
        }), /conflict/i);
        const s = {
            key: 'schedule', prompt: 'report', at: 3000, timezone: 'UTC'
        };
        service.createSchedule(h.source, s);
        assert.throws(() => service.createSchedule(h.source, {
            ...s, at: 4000
        }), /conflict/i);
    }
    finally {
        await h.close();
    }
});
test('paused schedules survive restart and do not fire until resumed', async()=>{
 const h=await fixture();
 try{
  let service=new ProactiveService(h.runtime,{now:h.now});
  const s=service.createSchedule(h.source,{key:'pause-restart',prompt:'report',at:2000,timezone:'Asia/Shanghai'});
  service.pauseSchedule(h.source.to,s.id);h.time(3000);await service.tick();assert.equal(service.listFires(h.source.to).length,0);
  service=new ProactiveService(await h.restart(),{now:h.now});await service.tick();assert.equal(service.listSchedules(h.source.to)[0].state,'paused');
  service.resumeSchedule(h.source.to,s.id);await service.tick();await h.runtime.idle();assert.equal(service.listFires(h.source.to).length,1);
  await service.tick();assert.equal(service.listFires(h.source.to).length,1);
 }finally{await h.close();}
});
