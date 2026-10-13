import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { readHidden } from '../src/daemon/hidden-entry.ts';
function tty() {
    const input = new PassThrough();
    const output = new PassThrough();
    let raw = false;
    const rawChanges: boolean[] = [];
    let displayed = '';
    Object.defineProperties(input, {
        isTTY: {
            value: true
        }, isRaw: {
            get: () => raw
        }, setRawMode: {
            value: (next: boolean) => {
                raw = next;
                rawChanges.push(next);
                return input;
            }
        }
    });
    Object.defineProperty(output, 'isTTY', {
        value: true
    });
    output.on('data', chunk => displayed += chunk.toString());
    return {
        input, output, rawChanges, get displayed() {
            return displayed;
        }, get raw() {
            return raw;
        }
    };
}
test('hidden terminal: fake secret reaches caller with no echo/history and raw state restored', async () => {
    const t = tty();
    const input = Buffer.from('SYNTHETIC-NOT-A-REAL-KEY\n');
    const pending = readHidden('Synthetic fixture', t.input as unknown as ReadStream, t.output as unknown as WriteStream);
    assert.equal(t.raw, true);
    t.input.write(input);
    assert.equal(await pending, 'SYNTHETIC-NOT-A-REAL-KEY');
    assert.doesNotMatch(t.displayed, /SYNTHETIC-NOT-A-REAL-KEY/);
    assert.ok(input.every(byte => byte === 0));
    assert.deepEqual(t.rawChanges, [true, false]);
});
test('hidden terminal: cancellation/control sequence clears buffers and restores terminal', async () => {
    for (const suffix of ['\x03', '\x1b']) {
        const t = tty();
        const pending = readHidden('Fixture', t.input as unknown as ReadStream, t.output as unknown as WriteStream);
        const bytes = Buffer.from('SYNTHETIC' + suffix);
        t.input.write(bytes);
        await assert.rejects(pending, /Credential entry/);
        assert.equal(t.raw, false);
        assert.doesNotMatch(t.displayed, /SYNTHETIC/);
        assert.ok(bytes.every(b => b === 0));
    }
});
test('hidden terminal: rejects noninteractive pipes and hostile labels before reading', async () => {
    await assert.rejects(readHidden('Fixture', new PassThrough() as unknown as ReadStream, new PassThrough() as unknown as WriteStream), /interactive TTY/);
    const t = tty();
    await assert.rejects(readHidden('escape\x1b', t.input as unknown as ReadStream, t.output as unknown as WriteStream), /Invalid credential label/);
    assert.deepEqual(t.rawChanges, []);
});
