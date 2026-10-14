import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionFactory, } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore, type FauxResponseStep, } from '@earendil-works/pi-ai';
import { createContextExtension, type ContextOptions, type SummarySnapshot } from '../src/pi/context.ts';
import { createModelSummarizer } from '../src/pi/session-factory.ts';
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => resolve = r);
    return {
        promise, resolve
    };
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!check()) {
        if (Date.now() > deadline)
            throw new Error('Timed out waiting for native Pi lifecycle');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
const user = (content: string): Extract<AgentMessage, {
    role: 'user';
}> => ({
    role: 'user', content, timestamp: 1
});
const history = (count = 8, size = 600): Parameters<SessionManager['appendMessage']>[0][] => Array.from({
    length: count
}, (_, index) => index % 2 === 0
    ? user(`SEED_${index}_INSTRUCTION ${'x'.repeat(size)}`)
    : fauxAssistantMessage(`SEED_${index}_RESPONSE ${'y'.repeat(size)}`, {
        timestamp: index + 1
    }));
const texts = (value: unknown): string => JSON.stringify(value);
/** A real Pi 1.1 session. Only the provider transport is fake; no network or paid calls. */
async function setup(steps: FauxResponseStep[], context: Partial<ContextOptions> = {}, seed = history(), before: ExtensionFactory[] = []) {
    const dir = await mkdtemp(join(tmpdir(), 'pi-native-compaction-'));
    const faux = fauxProvider({
        provider: `compaction-${Math.random().toString(36).slice(2)}`,
        models: [{
                id: 'mock', contextWindow: 128000, maxTokens: 4096
            }],
        tokensPerSecond: 1000000,
    });
    faux.setResponses(steps);
    const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null,
        modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false,
    });
    const errors: unknown[] = [];
    const sessions: AgentSession[] = [];
    const open = async (manager: SessionManager, overrides: Partial<ContextOptions> = {}) => {
        const settings = SettingsManager.inMemory({
            compaction: {
                enabled: false
            }, retry: {
                enabled: false
            }
        });
        const loader = new DefaultResourceLoader({
            cwd: dir, agentDir: dir, settingsManager: settings,
            noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
            extensionFactories: [pi => pi.registerProvider(faux.provider), ...before, createContextExtension({
                    getState: () => ({
                        pendingJobs: ['JOB_PENDING'], questions: ['QUESTION_PENDING']
                    }),
                    maxContextTokens: 20000, outputReserveTokens: 1000,
                    thresholdTokens: 3000, recentMessages: 2,
                    onError: error => errors.push(error),
                    ...context, ...overrides,
                })],
            systemPromptOverride: () => 'NATIVE_SYSTEM_SENTINEL: preserve the complete native conversation.',
        });
        await loader.reload();
        const { session } = await createAgentSession({
            cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel(),
            settingsManager: settings, resourceLoader: loader, sessionManager: manager, noTools: 'builtin',
        });
        session.setAutoCompactionEnabled(false);
        await session.bindExtensions({
            mode: 'json', onError: error => errors.push(error)
        });
        sessions.push(session);
        return session;
    };
    const manager = SessionManager.create(dir, dir);
    for (const message of seed)
        manager.appendMessage(message);
    const session = await open(manager);
    return {
        dir, faux, modelRuntime, manager, session, errors, open,
        async close() {
            for (const active of sessions) {
                await active.agent.waitForIdle();
                active.dispose();
            }
            await rm(dir, {
                recursive: true, force: true
            });
        },
    };
}
test('native compaction: pending summary never trims history or waits before the next provider request', async () => {
    const summary = deferred<string>();
    const snapshots: SummarySnapshot[] = [];
    const requests: unknown[] = [];
    const h = await setup([0, 1].map(index => ctx => {
        requests.push(structuredClone(ctx));
        return fauxAssistantMessage(`FOREGROUND_${index}_DONE`);
    }), {
        summarize: snapshot => {
            snapshots.push(snapshot);
            return summary.promise;
        },
    });
    try {
        await h.session.prompt('FOREGROUND_0');
        await until(() => snapshots.length === 1);
        assert.equal(h.faux.state.callCount, 1);
        assert.equal(h.manager.getBranch().filter(entry => entry.type === 'compaction').length, 0);
        await h.session.prompt('FOREGROUND_1');
        assert.equal(h.faux.state.callCount, 2, 'the next model call must not await the summary');
        assert.equal(snapshots.length, 1, 'only one summary may be in flight');
        for (const request of requests) {
            for (let index = 0; index < 8; index++)
                assert.match(texts(request), new RegExp(`SEED_${index}_`));
            assert.match(texts(request), /NATIVE_SYSTEM_SENTINEL/);
            assert.match(texts(request), /JOB_PENDING/);
            assert.match(texts(request), /QUESTION_PENDING/);
            assert.doesNotMatch(texts(request), /omittedMessages|Tool result omitted/);
        }
        assert.match(texts(requests[1]), /FOREGROUND_0_DONE/);
        assert.match(texts(h.manager.buildSessionContext().messages), /SEED_0_INSTRUCTION/);
        assert.equal(h.errors.length, 0);
    }
    finally {
        summary.resolve('cleanup summary');
        await tick();
        await h.close();
    }
});
test('native compaction: ready boundary appends durable compaction, preserves later arrivals and extension entries, and survives restart', async () => {
    const summary = deferred<string>();
    const laterSummary = deferred<string>();
    const releaseProvider = deferred<void>();
    const providerStarted = deferred<void>();
    const snapshots: SummarySnapshot[] = [];
    let continued = '';
    let resumed = '';
    let signal: AbortSignal | undefined;
    let addExternalEntry = true;
    const h = await setup([
        async (_ctx, options) => {
            signal = options?.signal;
            providerStarted.resolve();
            await releaseProvider.promise;
            return fauxAssistantMessage('RESPONSE_AFTER_SNAPSHOT');
        },
        ctx => {
            continued = texts(ctx);
            return fauxAssistantMessage('LATE_ARRIVAL_HANDLED');
        },
        ctx => {
            resumed = texts(ctx);
            return fauxAssistantMessage('RESTART_HANDLED');
        },
    ], {
        summarize: snapshot => {
            snapshots.push(snapshot);
            return snapshots.length === 1 ? summary.promise : laterSummary.promise;
        },
    }, history(), [pi => {
            pi.on('turn_end', event => {
                if (!addExternalEntry)
                    return;
                addExternalEntry = false;
                return {
                    entries: [...event.entries, {
                            type: 'custom_message', customType: 'other-extension', display: false,
                            content: 'OTHER_EXTENSION_BOUNDARY_MESSAGE',
                        }]
                };
            });
        }]);
    try {
        const running = h.session.prompt('REQUEST_AFTER_SNAPSHOT');
        await providerStarted.promise;
        await until(() => snapshots.length === 1);
        const snapshotJson = texts(snapshots[0]!.messages);
        assert.match(snapshotJson, /SEED_0_INSTRUCTION/);
        await h.session.prompt('LATE_USER_ARRIVAL', {
            streamingBehavior: 'steer'
        });
        summary.resolve('COMPACTED_NATIVE_SUMMARY');
        await tick();
        await tick();
        assert.equal(h.manager.getBranch().filter(entry => entry.type === 'compaction').length, 0, 'ready alone cannot mutate the session mid-request');
        assert.equal(signal?.aborted, false, 'summary completion must not preempt the foreground');
        releaseProvider.resolve();
        await running;
        const branch = h.manager.getBranch();
        const compactions = branch.filter(entry => entry.type === 'compaction');
        assert.equal(compactions.length, 1);
        assert.equal(compactions[0]!.summary, 'COMPACTED_NATIVE_SUMMARY');
        assert.equal(compactions[0]!.fromHook, true);
        assert.ok(branch.some(entry => entry.type === 'custom_message' && entry.customType === 'other-extension'));
        assert.match(texts(branch), /SEED_0_INSTRUCTION/, 'original source history remains durable');
        assert.match(continued, /COMPACTED_NATIVE_SUMMARY/);
        assert.doesNotMatch(continued, /SEED_0_INSTRUCTION/);
        assert.match(continued, /SEED_7_RESPONSE/);
        assert.match(continued, /REQUEST_AFTER_SNAPSHOT/);
        assert.match(continued, /RESPONSE_AFTER_SNAPSHOT/);
        assert.match(continued, /LATE_USER_ARRIVAL/);
        assert.match(continued, /OTHER_EXTENSION_BOUNDARY_MESSAGE/);
        assert.equal(signal?.aborted, false);
        const path = h.manager.getSessionFile()!;
        const disk = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.equal(disk.filter(entry => entry.type === 'compaction').length, 1);
        h.session.dispose();
        const reopened = SessionManager.open(path, h.dir, h.dir);
        const restored = texts(reopened.buildSessionContext().messages);
        assert.match(restored, /COMPACTED_NATIVE_SUMMARY/);
        assert.doesNotMatch(restored, /SEED_0_INSTRUCTION/);
        assert.match(restored, /LATE_USER_ARRIVAL/);
        const replacement = await h.open(reopened, {
            summarize: undefined
        });
        await replacement.prompt('AFTER_RESTART');
        assert.match(resumed, /COMPACTED_NATIVE_SUMMARY/);
        assert.match(resumed, /LATE_ARRIVAL_HANDLED/);
        assert.match(resumed, /AFTER_RESTART/);
        assert.doesNotMatch(resumed, /SEED_0_INSTRUCTION/);
        assert.equal(h.errors.length, 0);
    }
    finally {
        summary.resolve('cleanup summary');
        laterSummary.resolve('cleanup later summary');
        releaseProvider.resolve();
        await tick();
        await h.close();
    }
});
test('native compaction: below threshold leaves native history intact and starts no summary', async () => {
    let calls = 0;
    let request = '';
    const h = await setup([ctx => {
            request = texts(ctx);
            return fauxAssistantMessage('done');
        }], {
        thresholdTokens: 18000,
        summarize: async () => {
            calls++;
            return 'must not run';
        },
    }, history(4, 20));
    try {
        await h.session.prompt('SMALL_REQUEST');
        await tick();
        assert.equal(calls, 0);
        for (let index = 0; index < 4; index++)
            assert.match(request, new RegExp(`SEED_${index}_`));
        assert.equal(h.manager.getBranch().filter(entry => entry.type === 'compaction').length, 0);
        assert.equal(h.errors.length, 0);
    }
    finally {
        await h.close();
    }
});
test('native compaction: aborted pre-model overflow still commits an idle-ready summary at turn_end', async () => {
    const summary = deferred<string>();
    let launched = false;
    const boundaryOutcomes: string[] = [];
    let resumed = '';
    const h = await setup([
        fauxAssistantMessage('FIRST_COMPLETE'),
        ctx => {
            resumed = texts(ctx);
            return fauxAssistantMessage('RECOVERED');
        },
    ], {
        maxContextTokens: 10500, outputReserveTokens: 1000,
        summarize: () => {
            launched = true;
            return summary.promise;
        },
    }, history(8, 650), [pi => {
            pi.on('turn_end', event => {
                boundaryOutcomes.push(event.outcome);
            });
        }]);
    try {
        await h.session.prompt('BEFORE_IDLE');
        await until(() => launched);
        assert.equal(h.faux.state.callCount, 1);
        summary.resolve('IDLE_READY_NATIVE_SUMMARY');
        await tick();
        await tick();
        assert.equal(h.manager.getBranch().filter(entry => entry.type === 'compaction').length, 0);
        await h.session.prompt(`OVERFLOW_INPUT_MUST_SURVIVE ${'z'.repeat(2500)}`);
        assert.equal(h.faux.state.callCount, 1, 'overflow must never reach the provider');
        assert.ok(boundaryOutcomes.some(outcome => outcome === 'aborted' || outcome === 'error'), 'Pi must emit a failed turn_end for pre-model abort');
        assert.equal(h.manager.getBranch().filter(entry => entry.type === 'compaction').length, 1, 'ready summary must not be stranded by the overflow guard');
        assert.match(texts(h.manager.buildSessionContext().messages), /OVERFLOW_INPUT_MUST_SURVIVE/);
        assert.ok(h.errors.length > 0, 'the blocked foreground wake must be surfaced, not acknowledged as success');
        await h.session.prompt('RETRY_AFTER_NATIVE_ADOPTION');
        assert.equal(h.faux.state.callCount, 2);
        assert.match(resumed, /IDLE_READY_NATIVE_SUMMARY/);
        assert.match(resumed, /OVERFLOW_INPUT_MUST_SURVIVE/);
        assert.doesNotMatch(resumed, /SEED_0_INSTRUCTION/);
    }
    finally {
        summary.resolve('cleanup summary');
        await tick();
        await h.close();
    }
});
test('native compaction: timed-out abort-ignoring summaries stay single-flight while foreground requests proceed', async () => {
    const summary = deferred<string>();
    const snapshots: SummarySnapshot[] = [];
    const h = await setup(Array.from({
        length: 3
    }, () => fauxAssistantMessage('foreground completed')), {
        summaryTimeoutMs: 10,
        summarize: snapshot => {
            snapshots.push(snapshot);
            return summary.promise;
        },
    });
    try {
        await h.session.prompt('FIRST_REQUEST');
        await until(() => snapshots.length === 1);
        await until(() => snapshots[0]!.signal.aborted);
        await h.session.prompt('SECOND_REQUEST');
        await h.session.prompt('THIRD_REQUEST');
        assert.equal(h.faux.state.callCount, 3);
        assert.equal(snapshots.length, 1, 'timeout cannot launch overlapping work when an adapter ignores abort');
        summary.resolve('EXPIRED_SUMMARY_MUST_NOT_APPLY');
        await tick();
        await tick();
        assert.equal(h.manager.getBranch().filter(entry => entry.type === 'compaction').length, 0);
        assert.match(texts(h.manager.buildSessionContext().messages), /SEED_0_INSTRUCTION/);
        assert.doesNotMatch(texts(h.manager.buildSessionContext().messages), /EXPIRED_SUMMARY_MUST_NOT_APPLY/);
        assert.equal(h.errors.length, 0);
    }
    finally {
        summary.resolve('cleanup summary');
        await tick();
        await h.close();
    }
});
test('native compaction: repeated summary failure has bounded retries and never becomes a synchronous fallback', async () => {
    const summaryErrors: Error[] = [];
    const snapshots: SummarySnapshot[] = [];
    const requests: string[] = [];
    // The large retained tail makes the bounded older-prefix snapshot identical
    // across these short foreground turns, so the per-prefix retry cap is tested.
    const seed = [...history(6, 450), user(`LARGE_TAIL_MUST_REMAIN ${'t'.repeat(5500)}`)];
    const h = await setup(Array.from({
        length: 3
    }, () => ctx => {
        requests.push(texts(ctx));
        return fauxAssistantMessage('ok');
    }), {
        maxContextTokens: 13500, outputReserveTokens: 1000,
        recentMessages: 1, summaryRetryMs: 0, summaryMaxAttempts: 2,
        summarize: async (snapshot) => {
            snapshots.push(snapshot);
            throw new Error('summary service unavailable');
        },
        onSummaryError: error => {
            summaryErrors.push(error);
            throw new Error('observer failure must also stay out of the foreground');
        },
    }, seed);
    try {
        for (let index = 0; index < 3; index++) {
            await h.session.prompt(`SHORT_FOREGROUND_${index}`);
            await tick();
            await tick();
        }
        assert.equal(h.faux.state.callCount, 3);
        assert.equal(snapshots.length, 2, 'an unchanged failed snapshot stops retrying after its configured limit');
        assert.equal(summaryErrors.length, 2);
        assert.equal(texts(snapshots[0]!.messages), texts(snapshots[1]!.messages));
        for (const request of requests) {
            assert.match(request, /SEED_0_INSTRUCTION/);
            assert.match(request, /LARGE_TAIL_MUST_REMAIN/);
            assert.doesNotMatch(request, /Tool result omitted|omittedMessages/);
        }
        assert.equal(h.manager.getBranch().filter(entry => entry.type === 'compaction').length, 0);
        assert.equal(h.errors.length, 0);
    }
    finally {
        await h.close();
    }
});
test('native compaction: default model summarizer uses a separate bounded tool-free request while foreground proceeds', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    let summaryContext = '';
    let summaryLimit: number | undefined;
    let summarySignal: AbortSignal | undefined;
    const h = await setup([
        async (ctx, options) => {
            summaryContext = texts(ctx);
            summaryLimit = options?.maxTokens;
            summarySignal = options?.signal;
            started.resolve();
            await release.promise;
            return fauxAssistantMessage('DEFAULT_SUMMARY_RESULT');
        },
        fauxAssistantMessage('FOREGROUND_WITH_PENDING_DEFAULT_SUMMARY'),
    ], {
        thresholdTokens: 18000
    }, history(2, 20));
    try {
        const summarize = createModelSummarizer(h.modelRuntime, h.faux.getModel());
        const runningSummary = summarize({
            sessionId: h.manager.getSessionId(),
            messages: [user('SUMMARIZED_PREFIX_ONLY')],
            state: {
                pendingJobs: ['SUMMARY_JOB']
            }, signal: controller.signal,
        });
        await started.promise;
        await h.session.prompt('NEW_FOREGROUND_INPUT');
        assert.equal(h.faux.state.callCount, 2, 'the background provider call must not serialize foreground requests');
        assert.match(summaryContext, /SUMMARIZED_PREFIX_ONLY/);
        assert.match(summaryContext, /SUMMARY_JOB/);
        assert.doesNotMatch(summaryContext, /context_history|toolsAdded/);
        assert.equal(summaryLimit, 4096);
        assert.equal(summarySignal, controller.signal);
        assert.equal(controller.signal.aborted, false);
        assert.doesNotMatch(texts(h.manager.getBranch()), /SUMMARIZED_PREFIX_ONLY/);
        assert.match(texts(h.manager.getBranch()), /FOREGROUND_WITH_PENDING_DEFAULT_SUMMARY/);
        release.resolve();
        assert.equal(await runningSummary, 'DEFAULT_SUMMARY_RESULT');
        assert.equal(h.errors.length, 0);
    }
    finally {
        release.resolve();
        await h.close();
    }
});
test('native compaction: a later compaction summarizes the previous native summary plus the accumulated tail', async () => {
    const summaryGates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const providerGates = [deferred<void>(), deferred<void>()];
    const started = [deferred<void>(), deferred<void>()];
    const snapshots: SummarySnapshot[] = [];
    const h = await setup([0, 1].map(index => async () => {
        started[index]!.resolve();
        await providerGates[index]!.promise;
        return fauxAssistantMessage(`NATIVE_RESPONSE_${index}`);
    }), {
        thresholdTokens: 1000,
        summarize: snapshot => {
            snapshots.push(snapshot);
            return summaryGates[Math.min(snapshots.length - 1, 2)]!.promise;
        },
    });
    try {
        const first = h.session.prompt('FIRST_NATIVE_REQUEST');
        await started[0]!.promise;
        await until(() => snapshots.length === 1);
        summaryGates[0]!.resolve('FIRST_NATIVE_SUMMARY');
        await tick();
        await tick();
        providerGates[0]!.resolve();
        await first;
        assert.equal(h.manager.getBranch().filter(entry => entry.type === 'compaction').length, 1);
        const second = h.session.prompt('SECOND_NATIVE_REQUEST');
        await started[1]!.promise;
        await until(() => snapshots.length === 2);
        assert.match(texts(snapshots[1]!.messages), /FIRST_NATIVE_SUMMARY/);
        assert.match(texts(snapshots[1]!.messages), /SEED_7_RESPONSE/);
        assert.doesNotMatch(texts(snapshots[1]!.messages), /SEED_0_INSTRUCTION/);
        summaryGates[1]!.resolve('SECOND_NATIVE_SUMMARY_RETAINS_PRIOR_FACTS');
        await tick();
        await tick();
        providerGates[1]!.resolve();
        await second;
        assert.equal(h.manager.getBranch().filter(entry => entry.type === 'compaction').length, 2);
        const active = texts(h.manager.buildSessionContext().messages);
        assert.match(active, /SECOND_NATIVE_SUMMARY_RETAINS_PRIOR_FACTS/);
        assert.match(active, /SECOND_NATIVE_REQUEST/);
        assert.match(active, /NATIVE_RESPONSE_1/);
        assert.doesNotMatch(active, /SEED_0_INSTRUCTION/);
        const reopened = SessionManager.open(h.manager.getSessionFile()!, h.dir, h.dir);
        assert.deepEqual(reopened.buildSessionContext().messages, h.manager.buildSessionContext().messages);
        assert.equal(h.faux.state.callCount, 2);
        assert.equal(h.errors.length, 0);
    }
    finally {
        for (const gate of providerGates)
            gate.resolve();
        for (const gate of summaryGates)
            gate.resolve('cleanup summary');
        await tick();
        await h.close();
    }
});
test('native compaction: summary becoming ready after idle waits for next safe native boundary', async () => {
    const summary = deferred<string>();
    let started = false;
    const h = await setup([fauxAssistantMessage('idle'), fauxAssistantMessage('next')], {
        summarize: async () => {
            started = true;
            return summary.promise;
        }
    });
    try {
        await h.session.prompt('first wake');
        await until(() => started);
        assert.equal(h.manager.getBranch().filter(e => e.type === 'compaction').length, 0);
        const requests = h.faux.state.callCount;
        summary.resolve('LATE_IDLE_SUMMARY');
        await tick();
        await tick();
        assert.equal(h.faux.state.callCount, requests, 'summary adoption does not create a provider request');
        assert.equal(h.manager.getBranch().filter(e => e.type === 'compaction').length, 0, 'no mid-idle transcript mutation');
        await h.session.prompt('new input after idle');
        assert.ok(h.manager.getBranch().some(e => e.type === 'compaction' && e.summary === 'LATE_IDLE_SUMMARY'));
        assert.equal(h.errors.length, 0);
    }
    finally {
        summary.resolve('LATE_IDLE_SUMMARY');
        await h.close();
    }
});
test('background model summarizer reserves its actual request before dispatch and fails closed at host cap', async () => {
    let reservations = 0, dispatches = 0;
    const model = {
        contextWindow: 128000, maxTokens: 16384
    } as any;
    const models = {
        async completeSimple() {
            dispatches++;
            return fauxAssistantMessage('Stable requirements and pending task.');
        }
    } as any;
    const beforeRequest = (context: unknown, max: number) => {
        reservations++;
        assert.ok(JSON.stringify(context).includes('stablePrefix'));
        assert.equal(max, 16384);
    };
    const summarize = createModelSummarizer(models, model, {
        beforeRequest
    });
    const snapshot = {
        sessionId: 'cap', messages: [user('Stable requirement')], state: {}, signal: new AbortController().signal
    };
    await summarize(snapshot);
    assert.equal(reservations, 1);
    assert.equal(dispatches, 1);
    const capped = createModelSummarizer(models, model, {
        beforeRequest() {
            throw Error('request cap');
        }
    });
    await assert.rejects(() => capped(snapshot), /request cap/);
    assert.equal(dispatches, 1);
});
test('background summary gives reasoning-capable models room for a usable summary within the output ceiling', async () => {
    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false
    });
    const faux = fauxProvider({
        models: [{
                id: 'summary', reasoning: true, maxTokens: 65536, contextWindow: 256000
            }]
    });
    models.registerNativeProvider(faux.provider);
    let limit: number | undefined;
    faux.setResponses([(_context, options) => {
            limit = options?.maxTokens;
            return fauxAssistantMessage('A factual summary retaining the still-valid tasks.');
        }]);
    const summary = await createModelSummarizer(models, faux.getModel())({
        sessionId: 'budget-room', messages: [user('Still-valid task, original ID and route.')], state: {}, signal: new AbortController().signal
    });
    assert.ok(summary.includes('still-valid'));
    assert.equal(limit, 16384);
    faux.setResponses([(_context, options) => {
            limit = options?.maxTokens;
            return fauxAssistantMessage('Bounded summary.');
        }]);
    await createModelSummarizer(models, faux.getModel(), {
        maxTokens: 65536
    })({
        sessionId: 'cap-override', messages: [user('An unfinished task.')], state: {}, signal: new AbortController().signal
    });
    assert.equal(limit, 16384, 'an explicit override cannot exceed the per-request ceiling');
});
