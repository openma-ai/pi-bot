import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { makePiAgentDriver, type PiTurnSession } from '../src/openmatter/pi-agent-driver.ts';

test('Pi driver steers a streaming session once per steerId and rejects an idle one', async () => {
    const steers: string[] = [];
    const pi = { isStreaming: false, steer: async (text: string) => { steers.push(text); return 'queued'; }, prompt: async () => {}, subscribe: () => () => {}, abort: async () => {} } as unknown as PiTurnSession & { isStreaming: boolean };
    const driver = makePiAgentDriver({ id: 'pi', openSession: async () => pi, content: () => 'go left' });
    await Effect.runPromise(driver.createSession({ sessionId: 's', bindingKey: 'b', generation: 1, idempotencyKey: 's' }));
    const steer = (steerId: string) => Effect.runPromise(driver.steer({ session: { id: 's' }, sessionId: 's', turnId: 't', steerId, context: {} as never }));
    assert.equal((await steer('a')).status, 'rejected');
    (pi as any).isStreaming = true;
    assert.deepEqual(await steer('a'), { status: 'accepted' });
    assert.deepEqual(await steer('a'), { status: 'accepted' });
    assert.deepEqual(steers, ['go left']);
    assert.equal((await Effect.runPromise(driver.capabilities()) as { steering?: boolean }).steering, true);
});
