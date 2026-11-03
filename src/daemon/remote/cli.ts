/**
 * `pi-bot pair` / `pi-bot devices`: headless pairing and device admin against the running daemon.
 * Works over SSH: prints an ASCII QR plus a short manual code. Uses the local daemon.token (0600).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';

async function admin(dataDir: string, path: string, body?: unknown) {
    const info = JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8'));
    const url = new URL(info.http);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw Error('Only local daemon control is supported');
    const token = readFileSync(join(dataDir, 'daemon.token'), 'utf8').trim();
    const r = await fetch(new URL(path, url), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000)
    });
    const out = await r.json();
    if (!r.ok) throw Error(path + ' failed: ' + (out.error ?? r.status));
    return out;
}

export async function remoteCli(command: 'pair' | 'devices', args: string[], dataDir: string, write = (s: string) => process.stdout.write(s)) {
    if (command === 'pair') {
        if (args.includes('--rotate')) {
            const r = await admin(dataDir, '/remote/admin', { action: 'rotate-code' });
            write(`Connect code rotated (generation ${r.generation}). Old QR codes and links no longer work; every device must pair again.\n`);
        }
        const p = await admin(dataDir, '/remote/admin', { action: 'pair' });
        if (args.includes('--json')) { write(JSON.stringify(p) + '\n'); return; }
        if (!args.includes('--no-qr')) write(await QRCode.toString(p.link, { type: 'terminal', small: true, errorCorrectionLevel: 'L' }) + '\n');
        write(`Pairing code: ${p.code}   (single use, expires in ${Math.round((p.expiresAt - Date.now()) / 60000)} min)\n`);
        write(p.relay ? `Remote: via relay ${p.relay} (${p.relayStatus}), end-to-end encrypted.\n` : 'Remote access is off (no relay configured); the code pairs local clients only.\n');
        write(`Pairing link (copy into the client if you cannot scan):\n${p.link}\n`);
        write('Running `pi-bot pair` again invalidates this code. Treat the link like a password.\n');
        return;
    }
    const [sub = 'list', arg] = args;
    if (sub === 'list') {
        const r = await admin(dataDir, '/remote/devices');
        write(`relay: ${r.relay.status}\n`);
        for (const d of r.devices) write(`${d.id}  ${d.name}  via=${d.via}  paired=${d.createdAt}  lastSeen=${d.lastSeenAt ?? '-'}\n`);
        if (!r.devices.length) write('(no paired devices)\n');
    } else if (sub === 'revoke') {
        if (!arg) throw Error('Usage: pi-bot devices revoke <id>');
        const r = await admin(dataDir, '/remote/devices/revoke', { id: arg });
        write(r.revoked ? `Revoked ${arg}.\n` : `No device ${arg}.\n`);
    } else if (sub === 'provision') {
        const r = await admin(dataDir, '/remote/admin', { action: 'provision', name: arg ?? 'ci' });
        // Printed once, for piping into a secret store. Revoke with `pi-bot devices revoke <id>`.
        write(JSON.stringify(r) + '\n');
    } else if (sub === 'rotate-code') {
        const r = await admin(dataDir, '/remote/admin', { action: 'rotate-code' });
        write(`Connect code rotated (generation ${r.generation}).\n`);
    } else throw Error('Usage: pi-bot devices [list|revoke <id>|provision [name]|rotate-code]');
}
