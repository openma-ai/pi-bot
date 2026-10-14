import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Value } from 'typebox/value';
import { methods, notifications, PROTOCOL_VERSION } from '../src/sdk/protocol/index.ts';
test('exported method and notification JSON Schema matches the reviewed registry snapshot', () => {
    assert.deepEqual(JSON.parse(JSON.stringify({
        version: PROTOCOL_VERSION, methods, notifications
    })), JSON.parse(readFileSync('test/fixtures/protocol-schema.json', 'utf8')));
    for (const [method, definition] of Object.entries(methods))
        if (Object.keys((definition.params as any).properties ?? {}).length)
            assert.equal(Value.Check(definition.params, {
                __unknown: true
            }), false, method);
});
