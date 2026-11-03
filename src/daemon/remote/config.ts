/**
 * Remote access is OPTIONAL and off by default. It turns on only when a relay URL is configured, by
 * (first match wins) `--relay <url>`, `PI_BOT_RELAY_URL`, or `<dataDir>/remote.json` `{"relay":{"url":...,"enabled":true}}`.
 * `--no-relay` / `PI_BOT_RELAY=off` force it off. The registration key comes from `--relay-key-file`,
 * `PI_BOT_RELAY_KEY_FILE` or `PI_BOT_RELAY_KEY` (prefer files; never logged).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RemoteAccessOptions } from '../transports/http.ts';

export function remoteAccessOptions(dataDir: string, option: (name: string) => string | undefined, argv = process.argv, env = process.env): RemoteAccessOptions | undefined {
    if (argv.includes('--no-relay') || env.PI_BOT_RELAY === 'off') return undefined;
    let file: any = {};
    const path = join(dataDir, 'remote.json');
    if (existsSync(path)) file = JSON.parse(readFileSync(path, 'utf8'))?.relay ?? {};
    const url = option('--relay') ?? env.PI_BOT_RELAY_URL ?? (file.enabled === false ? undefined : file.url);
    if (!url) return undefined;
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)))
        throw Error('Relay URL must be https (plain http only for a loopback test relay)');
    const keyFile = option('--relay-key-file') ?? env.PI_BOT_RELAY_KEY_FILE ?? file.keyFile;
    const registrationKey = keyFile ? readFileSync(keyFile, 'utf8').trim() : env.PI_BOT_RELAY_KEY;
    // Diagnostics only: frame kind, size and a 24-byte hex prefix of binary records (ciphertext). No paths, headers or secrets.
    const onFrame = env.PI_BOT_RELAY_DEBUG_FRAMES === '1' ? (f: { dir: string; kind: string; bytes: number; sample?: string }) => console.error(`relay-frame ${f.dir} ${f.kind} ${f.bytes}B${f.sample ? ' ' + f.sample : ''}`) : undefined;
    return { relayUrl: u.origin, registrationKey: registrationKey || undefined, name: option('--name') ?? file.name ?? 'pi-bot', ...(onFrame ? { onFrame } : {}) };
}
