import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopOwnership } from '../src/desktop-ownership.ts';
test('screen ownership is stable and foreign windows are rejected', () => {
    const r = new DesktopOwnership(2);
    const a = r.bind('a', 'target-a', 101), b = r.bind('b', 'target-b', 202);
    assert.equal(a.screen, 0);
    assert.equal(b.screen, 1);
    assert.equal(r.require('a', 101).targetId, 'target-a');
    assert.throws(() => r.require('a', 202), /ownership/);
    assert.throws(() => r.bind('c', 'c', 303), /capacity/);
    assert.throws(() => r.bind('a', 'another', 404), /already/);
});
test('takeover serializes shared desktop input and expiry resumes agents', () => {
    let now = 100;
    const r = new DesktopOwnership(2, () => now);
    r.bind('a', 'a', 101);
    r.bind('b', 'b', 202);
    r.takeover('a', 1000);
    assert.throws(() => r.requireAgent('b'), /takeover/);
    assert.throws(() => r.takeover('b', 1000), /takeover/);
    now = 1101;
    assert.equal(r.requireAgent('b').windowId, 202);
    r.takeover('a', 1000);
    r.release('a');
    assert.equal(r.requireAgent('a').windowId, 101);
});
