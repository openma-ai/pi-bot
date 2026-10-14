import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CredentialBroker } from '../src/daemon/runtime/credentials.ts';
const scope = {
    botId: 'bot-a', taskId: 'task-a', tool: 'synthetic-tool'
};
test('credential form: direct host entry, scoped one-use reference, fixed redacted outcomes', async () => {
    const broker = new CredentialBroker();
    const form = broker.request(scope, 'Synthetic fixture');
    assert.equal(form.fields[0]?.type, 'password');
    assert.throws(() => broker.submit(form.requestId, {
        ...scope, botId: 'other'
    }, 'SYNTHETIC-NOT-A-REAL-SECRET'));
    const receipt = broker.submit(form.requestId, scope, 'SYNTHETIC-NOT-A-REAL-SECRET');
    assert.doesNotMatch(JSON.stringify([form, receipt, broker]), /SYNTHETIC-NOT/);
    await assert.rejects(broker.use(receipt.reference, {
        ...scope, tool: 'other'
    }, async () => {
    }));
    assert.deepEqual(await broker.use(receipt.reference, scope, async (secret) => {
        throw Error(secret);
    }), {
        state: 'failed'
    });
    await assert.rejects(broker.use(receipt.reference, scope, async () => {
    }));
});
test('credential form: expiry, revoke, shutdown and mutation do not extend access', async () => {
    let now = 0;
    const broker = new CredentialBroker(() => now);
    const form = broker.request(scope, 'fixture', 10);
    form.scope.botId = 'attacker';
    form.expiresAt = 9999;
    const receipt = broker.submit(form.requestId, scope, 'SYNTHETIC');
    now = 10;
    await assert.rejects(broker.use(receipt.reference, scope, async () => {
    }));
    const next = broker.request(scope, 'fixture');
    broker.revoke(next.requestId);
    assert.throws(() => broker.submit(next.requestId, scope, 'SYNTHETIC'));
    const last = broker.request(scope, 'fixture');
    broker.close();
    assert.throws(() => broker.submit(last.requestId, scope, 'SYNTHETIC'));
});
