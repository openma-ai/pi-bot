import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopOwnership } from '../src/daemon/desktop-ownership.ts';
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

test('one viewer per bot, stale disconnect cannot release a restarted controller', () => {
    let now = 0;
    const r = new DesktopOwnership(2, () => now);
    r.bind('a', 'a', 101); r.bind('b', 'b', 202);
    r.claimViewer('a', 'old'); r.takeover('a');
    assert.throws(() => r.claimViewer('a', 'second'), /active viewer/);
    assert.throws(() => r.takeover('b'), /takeover/);
    assert.equal(r.releaseViewer('a', 'old'), true);
    assert.equal(r.control(), undefined);
    assert.equal(r.hasViewer('a'), false);
    r.claimViewer('a', 'restarted'); r.takeover('a');
    assert.equal(r.releaseViewer('a', 'old'), false);
    assert.equal(r.control()?.botId, 'a');
    now = 60001;
    assert.equal(r.control(), undefined);
    assert.equal(r.requireAgent('b').botId, 'b');
    assert.equal(r.releaseViewer('a', 'restarted'), true);
});
