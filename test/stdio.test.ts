import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { StdioTransport } from '../src/sdk/transports/stdio.ts';
import { PiBotClient } from '../src/sdk/client.ts';
test('stdio child completes handshake, durable turn and delivered output over JSONL', {
    timeout: 10000
}, async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/stdio-daemon.ts'], {
        stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', b => stderr += b);
    const lines = createInterface({
        input: child.stdout
    });
    const transport = new StdioTransport({
        write: line => {
            child.stdin.write(line);
        }, onLine: receive => {
            lines.on('line', receive);
            return () => lines.off('line', receive);
        }, close: () => child.stdin.end()
    });
    const client = await PiBotClient.connect({
        transport
    });
    try {
        const { bot } = await client.bot.create({
            name: 'stdio'
        });
        const snapshot = await client.daemon.snapshot({});
        const events: any[] = [];
        await client.events.subscribe({
            after: snapshot.seq
        }, e => events.push(e));
        await client.turn.start({
            botId: bot.id, text: 'work', key: 'one'
        });
        await new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => reject(Error('No completed turn')), 3000);
            const check = () => {
                if (events.some(e => e.method === 'turn/completed') && events.some(e => e.params.item?.text === 'stdio result' && e.params.item.delivery === 'delivered')) {
                    clearTimeout(deadline);
                    resolve();
                }
                else
                    setTimeout(check, 10);
            };
            check();
        });
        assert.ok(!stderr.includes('secret'));
    }
    finally {
        client.close();
        lines.close();
        child.kill('SIGTERM');
    }
});
