import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { ProviderFailureError, classifyProviderFailure, providerCodes } from '../src/pi/provider-failure.ts';
import { readProviderFailure } from '../src/sdk/provider-failure.ts';
import { toRpcError } from '../src/daemon/core/errors.ts';
import { taskFailure } from '../src/gui/presentation.ts';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';
import { piSessionFactory } from '../src/pi/session-factory.ts';

const sensitive = 'Bearer SYNTHETIC_TOKEN_DO_NOT_PERSIST https://fixture.invalid/return?code=SYNTHETIC_CODE person@fixture.invalid request-body-SYNTHETIC sk-fixture-secret-not-real';
const cases = [
    { raw: { status: 401, code: 'invalid_api_key', message: sensitive }, category: 'authentication', retry: 'after-authentication', status: 401, code: 'invalid_api_key' },
    { raw: `OpenAI API error (403): {"error":{"code":"permission_denied","message":"${sensitive}"}}`, category: 'permission', retry: 'after-configuration', status: 403, code: 'permission_denied' },
    { raw: `429 {"code":"rate_limit_exceeded","message":"${sensitive}"}`, category: 'rate-limit', retry: 'after-delay', status: 429, code: 'rate_limit_exceeded' },
    { raw: { status: 429, error: { code: 'subscription_sharing_usage_limit_exceeded', message: sensitive } }, category: 'quota', retry: 'after-quota', status: 429, code: 'subscription_sharing_usage_limit_exceeded' },
    { raw: `OpenAI API error (404): {"code":"model_not_found","message":"${sensitive}"}`, category: 'model', retry: 'after-configuration', status: 404, code: 'model_not_found' },
    { raw: { statusCode: 400, error: { type: 'invalid_request_error', message: sensitive } }, category: 'request', retry: 'after-configuration', status: 400, code: 'invalid_request_error' },
    { raw: new Error('fetch failed: ' + sensitive), category: 'network', retry: 'after-connection' },
    { raw: { message: sensitive, cause: { code: 'ECONNREFUSED' } }, category: 'network', retry: 'after-connection' },
    { raw: { code: 'ETIMEDOUT', message: sensitive }, category: 'timeout', retry: 'after-delay' },
    { raw: { status: 503, error: { code: 'overloaded_error', message: sensitive } }, category: 'service', retry: 'after-delay', status: 503, code: 'overloaded_error' },
    { raw: { message: sensitive, code: 'PRIVATE_ACCOUNT_CODE', request: sensitive }, category: 'unknown', retry: 'inspect' },
] as const;
function assertPrivate(value: unknown) {
    assert.doesNotMatch(JSON.stringify(value), /SYNTHETIC|fixture\.invalid|Bearer|sk-fixture|PRIVATE_ACCOUNT|request-body|https?:\/\//);
}
for (const [index, entry] of cases.entries()) test(`safe provider classification ${index}: ${entry.category}`, () => {
    const error = new ProviderFailureError(entry.raw, 'response');
    assert.equal(error.failure.category, entry.category);
    assert.equal(error.failure.retry, entry.retry);
    assert.equal(error.failure.httpStatus, 'status' in entry ? entry.status : undefined);
    assert.equal(error.failure.providerCode, 'code' in entry ? entry.code : undefined);
    assert.deepEqual(readProviderFailure(String(error)), error.failure);
    const rpc = toRpcError(error);
    assert.equal(rpc.data.reason, 'internal');
    assert.equal(rpc.data.retryable, false, 'a suggestion never bypasses explicit task recovery');
    assert.deepEqual(rpc.data.details?.providerFailure, error.failure);
    const ui = taskFailure({ status: 'uncertain', error: String(error) });
    assert.equal(ui?.code, 'provider.' + entry.category);
    assert.equal(taskFailure({ status: 'processed', error: String(error) }), undefined);
    assertPrivate([String(error), error, rpc, ui]);
});

test('SDK-only safe envelope remains compatible across every allowlisted provider code', () => {
    for (const providerCode of Object.keys(providerCodes)) {
        const error = new ProviderFailureError({ code: providerCode }, 'before-stream');
        assert.deepEqual(readProviderFailure(error.message), error.failure);
        assert.deepEqual(readProviderFailure('Error: ' + error.message), error.failure);
    }
});
test('unknown fields, response bodies, getters, cycles and oversized strings never escape', () => {
    let invoked = false;
    const object = Object.defineProperty({ body: sensitive, error: { message: sensitive } }, 'message', { get() { invoked = true; throw Error(sensitive); } });
    assert.equal(classifyProviderFailure(object, 'stream').category, 'unknown');
    assert.equal(invoked, false);
    const cycle: any = { code: sensitive }; cycle.error = cycle; cycle.cause = cycle;
    assertPrivate(new ProviderFailureError(cycle, 'stream'));
    assert.equal(classifyProviderFailure('x'.repeat(20_000) + '429', 'response').httpStatus, undefined);
    assert.equal(classifyProviderFailure('Failed https://fixture.invalid/401?model=model_not_found', 'response').category, 'unknown');
    for (const value of [sensitive, 'PiboProviderFailure/v1 category=unknown status=- code=PRIVATE_ACCOUNT retry=inspect phase=response',
        new ProviderFailureError('unknown', 'stream').message + sensitive,
        new ProviderFailureError('unknown', 'stream').message.replace('retry=inspect', 'retry=after-delay')]) {
        assert.equal(readProviderFailure(value), undefined);
        assertPrivate(taskFailure({ status: 'uncertain', error: value }));
    }
});

for (const phase of ['response', 'before-stream', 'stream', 'aborted'] as const)
test(`actual Pi session ${phase} keeps safe persisted diagnostics and task semantics without retry`, { timeout: 15_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pibo-provider-diagnostic-fixture-'));
    const faux = fauxProvider({ provider: 'diagnostic-fixture', models: [{ id: 'fixture-model', contextWindow: 128000, maxTokens: 4096 }], tokensPerSecond: 1000000 });
    const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
    const runtime = new BotRuntime(join(dir, 'runtime.db'), piSessionFactory({ dir: join(dir, 'sessions'), modelRuntime: models,
        model: faux.getModel(), tools: [], extensions: [pi => pi.registerProvider(faux.provider)] }));
    let calls = 0;
    faux.setResponses([() => { calls++; return fauxAssistantMessage('', { stopReason: phase === 'aborted' ? 'aborted' : 'error', errorMessage: cases[1].raw }); }]);
    if (phase === 'before-stream') models.streamSimple = () => { calls++; throw Object.assign(new Error(sensitive), { status: 403, code: 'permission_denied' }); };
    if (phase === 'stream') models.streamSimple = () => {
        calls++;
        const source = createAssistantMessageEventStream();
        source[Symbol.asyncIterator] = async function* () { throw Error('fetch failed: ' + sensitive); };
        source.result = async () => { throw Error(sensitive); };
        return source;
    };
    try {
        const bot = runtime.createBot('Synthetic diagnostic fixture');
        runtime.accept({ to: bot.id, text: 'Synthetic diagnostic test', key: 'diagnostic-fixture' });
        await runtime.idle();
        const inbox: any = runtime.store.list('inbox')[0], turn: any = runtime.store.list('turns')[0];
        assert.equal(calls, 1);
        assert.equal(inbox.state, 'uncertain');
        assert.equal(turn.status, 'failed');
        if (phase === 'aborted') {
            assert.equal(turn.error.reason, 'invalidRequest');
            assert.equal(turn.error.details?.providerFailure, undefined);
            assert.match(inbox.error, /Inference cancelled/);
        } else {
            const category = phase === 'stream' ? 'network' : 'permission';
            assert.equal(turn.error.reason, 'internal');
            assert.equal(turn.error.details.providerFailure.category, category);
            assert.equal(turn.error.details.providerFailure.httpStatus, phase === 'stream' ? undefined : 403);
            assert.equal(turn.error.details.providerFailure.phase, phase);
            assert.equal(taskFailure({ status: inbox.state, error: inbox.error })?.code, 'provider.' + category);
        }
        assertPrivate([inbox, turn, runtime.errors.map(e => String(e)), runtime.store.list('items')]);
        async function inspect(path: string): Promise<void> {
            for (const entry of await readdir(path, { withFileTypes: true })) {
                const file = join(path, entry.name);
                if (entry.isDirectory()) await inspect(file);
                else if (entry.name.endsWith('.jsonl')) assertPrivate(await readFile(file, 'utf8'));
            }
        }
        await inspect(join(dir, 'sessions'));
    } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});
