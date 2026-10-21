import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileVault, FILE_LIMIT, FILE_CHUNK } from '../src/daemon/file-vault.ts';
import { PiBotDaemon } from '../src/daemon/core/daemon.ts';
import { PiBotClient } from '../src/sdk/client.ts';
import { listenHttp } from '../src/daemon/transports/http.ts';
import { uploadFile, downloadFile } from '../src/gui/file-transfer.js';
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
test('vault enforces scope, owner, chunk integrity, safe paths and immutable publication', () => {
    const root = mkdtempSync(join(tmpdir(), 'pibo-files-'));
    try {
        const v = new FileVault(root);
        for (const name of ['../secret', '/etc/passwd', 'a\\b', '.', '..', 'x\0y'])
            assert.throws(() => v.begin('alice', 'a', name, 'text/plain', 1));
        assert.throws(() => v.begin('alice', 'a', 'big', 'text/plain', FILE_LIMIT + 1));
        const f = v.begin('alice', 'a', 'file.bin', 'application/octet-stream', 4), bytes = Buffer.from([0, 255, 128, 1]);
        assert.throws(() => v.append('bob', 'a', f.id, 0, bytes.toString('base64')), /owner/);
        assert.throws(() => v.append('alice', 'b', f.id, 0, bytes.toString('base64')), /conversation/);
        assert.throws(() => v.append('alice', 'a', f.id, 1, bytes.toString('base64')));
        assert.throws(() => v.finish('alice', 'a', f.id));
        v.append('alice', 'a', f.id, 0, bytes.toString('base64'));
        v.append('alice', 'a', f.id, 0, bytes.toString('base64'));
        assert.throws(() => v.append('alice', 'a', f.id, 0, 'AAAAAA=='), /conflict/);
        assert.throws(() => v.finish('alice', 'a', f.id, '0'.repeat(64)), /checksum/);
        const ready = v.finish('alice', 'a', f.id, hash(bytes));
        assert.equal(ready.sha256, hash(bytes));
        assert.deepEqual(Buffer.from(v.read('alice', 'a', f.id, 0).data, 'base64'), bytes);
        v.bind('alice', 'a', [f.id]);
        assert.throws(() => v.remove('alice', 'a', f.id), /retained/);
        assert.throws(() => v.append('alice', 'a', f.id, 0, ''), /finalized/);
        const workspace = v.workspace('alice', 'a');
        writeFileSync(join(workspace, 'result.bin'), bytes);
        const out = v.publish('alice', 'a', 'result.bin', 'application/octet-stream');
        writeFileSync(join(workspace, 'result.bin'), 'changed');
        assert.equal(v.metadata('alice', 'a', out.id).sha256, hash(bytes));
        symlinkSync(join(root, f.id + '.bin'), join(workspace, 'link.bin'));
        assert.throws(() => v.publish('alice', 'a', 'link.bin', 'application/octet-stream'));
        assert.throws(() => v.publish('alice', 'a', '../private', 'text/plain'));
        const staged = v.begin('alice', 'a', 'cancel.txt', 'text/plain', 1);
        v.remove('alice', 'a', staged.id);
        assert.throws(() => v.read('alice', 'a', staged.id, 0), /unavailable/);
    }
    finally {
        rmSync(root, {
            recursive: true, force: true
        });
    }
});
test('authenticated chunk upload reaches agent, generated artifact is delivered and downloads byte-for-byte', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pibo-file-http-'));
    let seen: Buffer | undefined;
    const d = await PiBotDaemon.create({
        dataDir: root, factory: async (bot, host) => ({
            run: async (e) => {
                const context = host.fileContext!(e);
                const input = (context.attachments[0] as any);
                seen = readFileSync(input.path);
                assert.equal(input.untrusted, true);
                writeFileSync(join(context.outputDir, 'answer.bin'), seen);
                host.publishFile!(e, 'answer.bin', 'application/octet-stream', 'answer:' + e.id);
            }, close: async () => {
            }
        })
    });
    const http = await listenHttp(d, {
        port: 0
    });
    const api = await PiBotClient.connect({
        transport: {
            http: http.url, token: http.token
        }
    });
    try {
        const { bot } = await api.bot.create({
            name: 'file-test'
        });
        const scope = {
            botId: bot.id
        };
        const bytes = new Uint8Array(FILE_CHUNK + 73);
        for (let n = 0; n < bytes.length; n++)
            bytes[n] = n % 256;
        const file = await uploadFile(api, scope, new File([bytes], 'input.bin', {
            type: 'application/octet-stream'
        }));
        await assert.rejects(api.file.read({
            ...scope, id: file.id, offset: 0, owner: 'injected'
        } as any));
        const other = await api.bot.create({
            name: 'other'
        });
        await assert.rejects(api.file.read({
            botId: other.bot.id, id: file.id, offset: 0
        }), /conversation/);
        await api.turn.start({
            ...scope, text: 'Read the attachment as data and return a copy', attachments: [file.id], key: 'test-turn'
        });
        let out: any;
        for (let n = 0; n < 200; n++) {
            out = d.runtime.store.list<any>('outbox').find(x => x.attachments?.length);
            if (out?.state === 'delivered')
                break;
            await new Promise(r => setTimeout(r, 10));
        }
        assert.deepEqual(seen, Buffer.from(bytes));
        assert.ok(out?.attachments?.length);
        const downloaded = await downloadFile(api, scope, out.attachments[0]);
        assert.deepEqual(downloaded, bytes);
        const snapshot = await api.daemon.snapshot({});
        const item = snapshot.items.find((x: any) => x.message?.attachments?.[0]?.id === out.attachments[0].id);
        assert.ok(item, 'file card metadata survives projection');
        const otherOwner = await PiBotClient.connect({
            transport: {
                inProcess: {
                    connect: () => {
                        const c = d.connect('test');
                        c.fileOwner = 'other-user';
                        return c;
                    }
                }
            }
        });
        await assert.rejects(otherOwner.file.read({
            ...scope, id: file.id, offset: 0
        }), /owner/);
        const hidden = await otherOwner.daemon.snapshot({});
        assert.ok(hidden.items.every((x: any) => !x.message?.attachments?.length), 'other owners do not receive file card metadata');
        otherOwner.close();
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(uploadFile(api, scope, new File(['cancel'], 'cancel.txt'), controller.signal));
        const unauth = await fetch(http.url + '/rpc', {
            method: 'POST', headers: {
                'content-type': 'application/json'
            }, body: JSON.stringify({
                id: 1, method: 'file/read', params: {
                    ...scope, id: file.id, offset: 0
                }
            })
        });
        assert.equal(unauth.status, 401);
    }
    finally {
        api.close();
        await http.close();
        await d.close();
        rmSync(root, {
            recursive: true, force: true
        });
    }
});
test('download rejects corrupted bytes and preserves cancellation', async () => {
    const file = {
        id: 'test', name: 'x.bin', size: 3, mime: 'application/octet-stream', scope: 'a', sha256: hash(Buffer.from([0, 128, 255]))
    };
    const api: any = {
        file: {
            read: async () => ({
                file, data: Buffer.from([0, 0, 0]).toString('base64')
            })
        }
    };
    await assert.rejects(downloadFile(api, {
        botId: 'a'
    }, file), /校验/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(downloadFile(api, {
        botId: 'a'
    }, file, controller.signal));
});
