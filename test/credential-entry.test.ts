import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('../src/gui/credential-entry.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const flush = () => new Promise(resolve => setImmediate(resolve));
function page(invoke: (method: string, body?: unknown) => Promise<unknown>) {
    const nodes: Record<string, any> = {};
    for (const key of ['form', 'input', 'button', '#status', 'h1', 'label', '#detail']) nodes[key] = { value: '', disabled: false, hidden: false, textContent: '', events: {}, addEventListener(name: string, fn: unknown) { this.events[name] = fn; } };
    const timers = new Map<number, () => unknown>(); let next = 0;
    const context = vm.createContext({ invoke, configureNativeViewport() {}, document: { querySelector: (key: string) => nodes[key] }, window: { addEventListener() {} }, setTimeout: (fn: () => unknown) => { const id = ++next; timers.set(id, fn); return id; }, clearTimeout: (id: number) => timers.delete(id) });
    vm.runInContext(source, context);
    return { nodes, async poll() { const [id, fn] = timers.entries().next().value!; timers.delete(id); await fn(); await flush(); }, async submit(value: string) { nodes.input.value = value; await nodes.form.events.submit({ preventDefault() {} }); await flush(); } };
}
test('safe window labels manual fallback without rendering SDK URLs and clears terminal input', async () => {
    let complete = false; let writes = 0;
    const view = page(async method => {
        if (method === 'credential_submit') { writes++; return; }
        return complete ? { state: 'complete', fieldType: 'none', label: '' } : { state: 'pending', fieldType: 'manual_code', label: 'https://untrusted.invalid/?code=not-rendered' };
    });
    await flush();
    assert.equal(view.nodes.label.textContent, '授权回跳地址');
    assert.equal(view.nodes.input.disabled, false);
    view.nodes.input.value = 'synthetic-unsubmitted'; complete = true; await view.poll();
    assert.equal(view.nodes.form.hidden, true); assert.equal(view.nodes.input.value, ''); assert.equal(writes, 0);
});
test('API key uses its exact label and a successful submission is never replayed', async () => {
    let writes = 0;
    const view = page(async method => {
        if (method === 'credential_submit') { writes++; return; }
        return { state: writes ? 'locked' : 'pending', fieldType: 'api_key', label: 'API key' };
    });
    await flush(); assert.equal(view.nodes.label.textContent, 'API key');
    await view.submit('synthetic-only'); await view.submit('synthetic-only');
    assert.equal(writes, 1); assert.equal(view.nodes.input.disabled, true);
});
test('an older native binary without metadata preserves the existing secure submit route', async () => {
    let writes = 0;
    const view = page(async method => {
        if (method === 'credential_form_metadata') throw 'Command credential_form_metadata not found';
        writes++; return;
    });
    await flush(); assert.equal(view.nodes.input.disabled, false);
    await view.submit('synthetic-only'); assert.equal(writes, 1); assert.match(view.nodes['#status'].textContent, /已提交/);
});
test('temporary metadata transport failure does not close an unfinished form', async () => {
    let attempts = 0;
    const view = page(async () => { if (!attempts++) throw { code: 'connectionLost', message: 'temporary' }; return { state: 'pending', fieldType: 'manual_code', label: '授权回跳地址' }; });
    await flush(); assert.equal(view.nodes.form.hidden, false); assert.equal(view.nodes.input.disabled, true);
    await view.poll(); assert.equal(view.nodes.input.disabled, false); assert.equal(view.nodes.form.hidden, false);
});
