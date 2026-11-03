#!/usr/bin/env node
// Desktop-side alma-relay agent for pi-bot.
//
// Dials yetone/alma-relay (protocol 2), registers a locally generated connect
// code, and forwards tunneled HTTP/WebSocket traffic to the local pi-bot
// daemon. There is no Alma end-to-end encryption layer: the relay sees
// plaintext HTTP/WebSocket content. See docs/alma-relay.md.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { connectRelay, RelayCloseError } from './alma-relay/session.mjs';

const DEFAULT_RELAY = 'https://alma-relay.hrhrngxy.workers.dev';
const DEFAULT_BACKEND = 'http://127.0.0.1:4317';
const DEFAULT_KEY_FILE = '/home/box/agent-data/alma-relay-registration.key';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const FATAL_CLOSE_CODES = new Set([4000, 4002, 4003, 4401]);
const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

const HELP = `Usage: node scripts/alma-relay-agent.mjs [options]

Bridge a local pi-bot daemon to an alma-relay server (protocol 2).

Options:
  --relay URL       Relay origin (default: ${DEFAULT_RELAY})
                    env RELAY_URL
  --code TOKEN      Connect code, [A-Za-z0-9_-]{16,128}
                    env CONNECT_CODE; generated when absent
  --backend URL     Local backend origin (default: ${DEFAULT_BACKEND})
                    env BACKEND_URL
  --key KEY         Relay registration key (avoid: visible in process list)
                    env RELAY_REGISTRATION_KEY
  --key-file PATH   File containing the registration key
                    env RELAY_REGISTRATION_KEY_FILE
                    default: ${DEFAULT_KEY_FILE} when it exists
  --name NAME       Name shown to the relay (default: pi-bot)
  --help            Show this help

The connect code is printed once at startup. Treat it as a password: anyone
with it can reach the backend through the relay.`;

const log = (...args) => console.error(`[${new Date().toISOString()}] [alma-relay]`, ...args);

async function main() {
    let config;
    try {
        config = loadConfig(process.argv.slice(2), process.env);
    } catch (error) {
        console.error(`[alma-relay] ${error.message}`);
        process.exitCode = 1;
        return;
    }
    if (config.help) {
        console.log(HELP);
        return;
    }

    printBanner(config);
    log(`backend ${config.backend.origin}${config.key ? '; registration key loaded' : '; no registration key'}`);

    const agent = new AlmaRelayAgent(config);
    process.once('SIGINT', () => agent.stop('SIGINT'));
    process.once('SIGTERM', () => agent.stop('SIGTERM'));
    await agent.run();
    process.exitCode = agent.exitCode;
}

class AlmaRelayAgent {
    constructor(config) {
        this.config = config;
        this.link = null;
        this.wake = null;
        this.stopping = false;
        this.attempt = 0;
        this.exitCode = 0;
    }

    async run() {
        while (!this.stopping) {
            const link = connectRelay({
                relayUrl: this.config.relay,
                tokenHash: this.config.tokenHash,
                name: this.config.name,
                version: this.config.version,
                key: this.config.key,
                backend: this.config.backend,
            });
            this.link = link;

            try {
                const { proto } = await link.ready;
                this.attempt = 0;
                log(`registered with relay (protocol ${proto})`);
                const { code, reason } = await link.closed;
                this.link = null;
                if (this.stopping) break;
                const disconnected = new RelayCloseError(
                    `disconnected (close ${code}${reason ? `: ${reason}` : ''})`,
                    code,
                );
                if (this.isFatal(disconnected)) {
                    this.reportFatal(disconnected);
                    return;
                }
                this.handleDisconnect(disconnected);
            } catch (error) {
                link.close();
                this.link = null;
                if (this.stopping) break;
                if (this.isFatal(error)) {
                    this.reportFatal(error);
                    return;
                }
                this.handleDisconnect(error);
            }

            const delay = this.nextDelay();
            log(`reconnecting in ${(delay / 1000).toFixed(1)} s (attempt ${this.attempt})`);
            await this.sleep(delay);
        }
    }

    handleDisconnect(error) {
        log(error?.message || 'connection lost');
    }

    isFatal(error) {
        if (!error) return false;
        if (error.fatal) return true;
        const code = Number(error.closeCode ?? error.code);
        return FATAL_CLOSE_CODES.has(code);
    }

    reportFatal(error) {
        const code = Number(error.closeCode ?? error.code);
        if (code === 4000) {
            log('another agent registered this connect code; not reconnecting');
            this.exitCode = 0;
            return;
        }
        log(`registration failed: ${error.message}`);
        this.exitCode = 1;
    }

    nextDelay() {
        const exponential = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * 2 ** Math.min(this.attempt, 10));
        this.attempt += 1;
        // Half fixed, half random: enough jitter to avoid a reconnect herd.
        return exponential / 2 + Math.random() * (exponential / 2);
    }

    sleep(ms) {
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.wake = null;
                resolve();
            }, ms);
            this.wake = () => {
                clearTimeout(timer);
                this.wake = null;
                resolve();
            };
        });
    }

    stop(signal) {
        if (this.stopping) return;
        this.stopping = true;
        log(`received ${signal}; shutting down`);
        this.link?.close();
        this.wake?.();
    }
}

function printBanner(config) {
    const clientUrl = `${config.relay}/c/${config.code}/`;
    console.log(`
alma-relay agent
  relay:        ${config.relay}
  backend:      ${config.backend.origin}
  connect code: ${config.code}
  client URL:   ${clientUrl}

Open the client URL from the phone/client, or use the relay origin when the
client asks for a remote URL (see docs/alma-relay.md). The connect code is a
bearer secret; it is printed only once. There is no Alma E2E encryption.`);
}

function loadConfig(argv, env) {
    const { values } = parseArgs({
        args: argv,
        allowPositionals: false,
        strict: true,
        options: {
            relay: { type: 'string' },
            code: { type: 'string' },
            backend: { type: 'string' },
            key: { type: 'string' },
            'key-file': { type: 'string' },
            name: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
    });

    if (values.help) return { help: true };

    const relay = normalizeRelay(values.relay ?? env.RELAY_URL ?? DEFAULT_RELAY);
    const backend = normalizeBackend(values.backend ?? env.BACKEND_URL ?? DEFAULT_BACKEND);
    const code = values.code ?? env.CONNECT_CODE ?? randomBytes(32).toString('base64url');
    if (!TOKEN_PATTERN.test(code)) {
        throw new Error('connect code must match [A-Za-z0-9_-]{16,128}');
    }

    const name = (values.name ?? 'pi-bot').trim();
    if (!name || name.length > 128 || /[\r\n]/.test(name)) {
        throw new Error('--name must be 1-128 characters without newlines');
    }

    return {
        relay,
        backend,
        code,
        tokenHash: createHash('sha256').update(code).digest('hex'),
        name,
        version: packageVersion(),
        key: resolveKey(values, env),
    };
}

function normalizeRelay(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('--relay/RELAY_URL must be an absolute URL');
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('--relay/RELAY_URL must be an http(s) or ws(s) origin');
    }
    return `${url.protocol === 'https:' || url.protocol === 'wss:' ? 'https' : 'http'}://${url.host}`;
}

function normalizeBackend(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('--backend/BACKEND_URL must be an absolute URL');
    }
    if (!['http:', 'https:'].includes(url.protocol)
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('--backend/BACKEND_URL must be an http(s) origin');
    }
    const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        host: url.host,
        origin: `${url.protocol}//${url.host}`,
        wsOrigin: `${wsProtocol}//${url.host}`,
    };
}

function resolveKey(values, env) {
    if (values.key !== undefined) return requiredKey(values.key, '--key');
    if (values['key-file'] !== undefined) return readKey(values['key-file'], '--key-file');
    if (env.RELAY_REGISTRATION_KEY) return requiredKey(env.RELAY_REGISTRATION_KEY, 'RELAY_REGISTRATION_KEY');
    if (env.RELAY_REGISTRATION_KEY_FILE) return readKey(env.RELAY_REGISTRATION_KEY_FILE, 'RELAY_REGISTRATION_KEY_FILE');
    if (existsSync(DEFAULT_KEY_FILE)) return readKey(DEFAULT_KEY_FILE, 'default registration key file');
    return undefined;
}

function requiredKey(value, source) {
    const key = value.trim();
    if (!key) throw new Error(`${source} is empty`);
    return key;
}

function readKey(path, source) {
    try {
        return requiredKey(readFileSync(path, 'utf8'), source);
    } catch (error) {
        if (error.code === 'ENOENT') throw new Error(`${source} not found: ${path}`);
        if (error.code === 'EACCES') throw new Error(`${source} is not readable: ${path}`);
        throw error;
    }
}

function packageVersion() {
    try {
        const value = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
        return typeof value === 'string' && value ? value : '0.2.0';
    } catch {
        return '0.2.0';
    }
}

try {
    await main();
} catch (error) {
    console.error(`[alma-relay] ${error.message}`);
    process.exitCode = 1;
}
