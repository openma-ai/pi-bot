import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopClient, createDesktopExtension } from '../src/pi/desktop-client.ts';
import { capability, unavailableDesktopCapabilities } from '../src/pi/desktop-capabilities.ts';
test('native Linux desktop does not tell Pi that its shell is on a different host', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pi-desktop-env-')), 'control.json');
    writeFileSync(file, JSON.stringify({
        url: 'http://127.0.0.1:6090', token: 'fixture', sameRuntime: true
    }));
    const desktop = DesktopClient.load(file)!;
    desktop.capabilities = async () => ({ ...unavailableDesktopCapabilities('linux', true), browser: capability('ready', 'Isolated fixture'), availableTools: { browser: ['navigate'], computer: [] } });
    desktop.bind = async () => ({
        botId: 'mine'
    });
    desktop.request = async () => new Response('{}');
    const tools: any[] = [];
    createDesktopExtension(desktop, 'mine')({
        registerTool: (t: any) => tools.push(t)
    } as any);
    const output = await tools.find(t => t.name === 'desktop_list').execute('call', {});
    const value = JSON.parse(output.content[0].text);
    assert.equal(value.environment.hostShellIsSeparate, false);
    assert.equal(value.environment.location, 'runtime');
});
