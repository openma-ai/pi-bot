import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeImage, IMAGE_LIMIT } from '../src/daemon/image-files.ts';
import { FileVault } from '../src/daemon/file-vault.ts';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';
import { piSessionFactory } from '../src/pi/session-factory.ts';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai';
const fixture = (ext: string) => readFileSync(new URL('./fixtures/images/synthetic.' + ext, import.meta.url));
function put(v: FileVault, owner: string, scope: string, bytes: Buffer, mime: string) {
    const file = v.begin(owner, scope, 'synthetic.png', mime, bytes.length);
    v.append(owner, scope, file.id, 0, bytes.toString('base64'));
    return v.finish(owner, scope, file.id);
}
test('safe raster headers, dimensions, size and MIME are enforced; SVG/HTML never become image inputs', () => {
    for (const [ext, mime] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']])
        assert.deepEqual(safeImage(fixture(ext), mime), {
            mime, width: 64, height: 48
        });
    assert.throws(() => safeImage(fixture('png'), 'image/jpeg'), /MIME/);
    assert.throws(() => safeImage(Buffer.from('<svg onload="alert(1)"/>'), 'image/png'), /签名/);
    assert.equal(safeImage(Buffer.from('<svg/>'), 'image/svg+xml'), undefined);
    assert.equal(safeImage(Buffer.from('<html/>'), 'text/html'), undefined);
    const oversized = Buffer.alloc(IMAGE_LIMIT + 1);
    fixture('png').copy(oversized);
    assert.throws(() => safeImage(oversized, 'image/png'), /5 MiB/);
    const dimensions = Buffer.from(fixture('png'));
    dimensions.writeUInt32BE(100000, 16);
    assert.throws(() => safeImage(dimensions, 'image/png'), /8192/);
    assert.throws(() => safeImage(fixture('png').subarray(0, 40), 'image/png'), /完整/);
    const root = mkdtempSync(join(tmpdir(), 'pibo-image-vault-'));
    try {
        const v = new FileVault(root), f = put(v, 'alice', 'scope', fixture('png'), 'application/octet-stream');
        assert.equal(f.mime, 'image/png');
        assert.equal(f.image?.width, 64);
        assert.equal(v.imageInputs('alice', 'scope', [f.id])[0].data, fixture('png').toString('base64'));
        assert.throws(() => v.imageInputs('other', 'scope', [f.id]), /owner/);
    }
    finally {
        rmSync(root, {
            recursive: true, force: true
        });
    }
});
for (const vision of [true, false])
    test(`real Pi image protocol with offline provider: vision=${vision}`, {
        timeout: 15000
    }, async () => {
        const root = mkdtempSync(join(tmpdir(), 'pibo-image-model-'));
        const faux = fauxProvider({
            provider: vision ? 'synthetic-vision' : 'synthetic-text', models: [{
                    id: 'mock', input: vision ? ['text', 'image'] : ['text'], contextWindow: 1000000, maxTokens: 4096
                }], tokensPerSecond: 1000000
        });
        let captured: any[] = [];
        let runtime!: BotRuntime;
        faux.setResponses([(context: any) => {
                captured = context.messages;
                const input = runtime.store.list<any>('inbox')[0];
                const workspace = runtime.fileContext(input);
                writeFileSync(join(workspace.outputDir, 'generated.png'), fixture('png'));
                return fauxAssistantMessage(fauxToolCall('publish_file', {
                    name: 'generated.png', mime: 'image/png', key: 'result'
                }, {
                    id: 'publish-image'
                }), {
                    stopReason: 'toolUse'
                });
            }, () => fauxAssistantMessage('done')]);
        const models = await ModelRuntime.create({
            credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, 'models.json'), refreshOnCreate: false
        });
        const model = {
            ...faux.getModel(), input: vision ? ['text', 'image'] : ['text']
        } as Model<any>;
        runtime = new BotRuntime(join(root, 'bot.db'), piSessionFactory({
            dir: join(root, 'sessions'), modelRuntime: models, model, extensions: [pi => pi.registerProvider(faux.provider)], preemptInference: false
        }));
        try {
            const bot = runtime.createBot('images');
            const scope = runtime.fileScope({
                to: bot.id
            });
            const f = put(runtime.files, 'synthetic-user', scope, fixture('png'), 'image/png');
            runtime.accept({
                to: bot.id, text: 'Inspect the synthetic image only if you support vision, then return a synthetic PNG.', key: 'input', fileOwner: 'synthetic-user', attachments: [f]
            });
            await runtime.idle();
            assert.deepEqual(runtime.errors, [], "offline model request failed");
            const imageParts = captured.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image');
            assert.equal(imageParts.length, vision ? 1 : 0);
            if (vision) {
                assert.equal(imageParts[0].data, fixture('png').toString('base64'));
                assert.equal(imageParts[0].mimeType, 'image/png');
            }
            else
                assert.match(JSON.stringify(captured), /当前模型不支持/);
            const input = runtime.store.list<any>('inbox')[0];
            assert.equal(input.imageInputStatus, vision ? 'attached' : 'unsupported');
            const out = runtime.store.list<any>('outbox')[0];
            assert.ok(out?.attachments?.[0]?.image, 'publish_file returns a previewable raster descriptor');
            assert.equal(out.attachments[0].image.width, 64);
            const read = runtime.files.read('synthetic-user', scope, out.attachments[0].id, 0);
            assert.deepEqual(Buffer.from(read.data, 'base64'), fixture('png'));
            assert.deepEqual(runtime.errors, []);
        }
        finally {
            await runtime.close();
            rmSync(root, {
                recursive: true, force: true
            });
        }
    });
