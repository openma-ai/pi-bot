/**
 * pi-bot remote E2E channel (v1), modeled on Alma Remote Access.
 *
 * Isomorphic: uses only WebCrypto (`globalThis.crypto.subtle`), so the same
 * file runs in Node >= 22, browsers, Tauri webviews and React Native with a
 * WebCrypto polyfill. No hand-rolled primitives: X25519, HKDF-SHA256,
 * HMAC-SHA256 and AES-256-GCM all come from the platform.
 *
 * Handshake (all binary values base64url):
 *   client -> daemon  {t:'hello',   v:1, pk:Ec, n:nc}
 *   daemon -> client  {t:'welcome', v:1, pk:Ed, n:nd, mac:HMAC(A, "server"||th)}
 *   client -> daemon  {t:'confirm', mac:HMAC(A, "client"||th)}
 * where A  = HKDF(C, info "pi-bot/e2e/auth/v1")      (C = connect code bytes)
 *       th = SHA-256("pi-bot/e2e/v1" || Ec || Ed || nc || nd)
 *       S  = X25519(e, E')                           (ephemeral, forward secret)
 *       keys = HKDF(S, salt HMAC(A, th), info "pi-bot/e2e/keys/v1") -> k_c2d || k_d2c
 * Both MACs prove knowledge of the connect code, so a relay (which only ever
 * sees sha256(route token)) cannot MITM the exchange.
 *
 * Records: binary [u64 BE counter][AES-256-GCM(ciphertext||tag)], IV = dir(4) || counter(8),
 * AAD = th. Counters start at 0 and must be strictly sequential (replay / reorder rejected).
 */
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const E2E_PATH = '/__pibot_e2e__';
export const E2E_VERSION = 1;

export function b64u(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(text: string): Uint8Array {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw Error('Invalid base64url');
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}
const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
};
const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const sha256 = async (b: Uint8Array) => new Uint8Array(await subtle.digest('SHA-256', b as BufferSource));
async function hmacKey(raw: Uint8Array) {
    return subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function hmac(raw: Uint8Array, data: Uint8Array) {
    return new Uint8Array(await subtle.sign('HMAC', await hmacKey(raw), data as BufferSource));
}
async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, bytes: number) {
    const key = await subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: enc.encode(info) }, key, bytes * 8));
}

/** Connect code: 32 random bytes, base64url (43 chars). */
export function generateConnectCode(): string { return b64u(random(32)); }
function codeBytes(code: string) {
    const raw = unb64u(code);
    if (raw.length !== 32) throw Error('Invalid connect code');
    return raw;
}
/** Routing token the relay sees in `/c/<token>`; a one-way derivation of the code. */
export async function routeToken(code: string): Promise<string> {
    return b64u(await hmac(codeBytes(code), enc.encode('pi-bot/route/v1')));
}
/** What the agent registers with (`th`). */
export async function routeTokenHash(token: string): Promise<string> {
    return [...await sha256(enc.encode(token))].map(b => b.toString(16).padStart(2, '0')).join('');
}
const authKey = (code: string) => hkdf(codeBytes(code), new Uint8Array(0), 'pi-bot/e2e/auth/v1', 32);

async function ephemeral() {
    const pair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
    return { pair, pub: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
}
async function agree(priv: CryptoKey, peer: Uint8Array) {
    if (peer.length !== 32) throw Error('Invalid peer key');
    const pub = await subtle.importKey('raw', peer as BufferSource, { name: 'X25519' }, false, []);
    const shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: pub } as any, priv, 256));
    if (shared.every(b => b === 0)) throw Error('Invalid peer key');
    return shared;
}
async function transcript(ec: Uint8Array, ed: Uint8Array, nc: Uint8Array, nd: Uint8Array) {
    return sha256(concat(enc.encode('pi-bot/e2e/v1'), ec, ed, nc, nd));
}
async function sessionKeys(shared: Uint8Array, auth: Uint8Array, th: Uint8Array) {
    const okm = await hkdf(shared, await hmac(auth, th), 'pi-bot/e2e/keys/v1', 64);
    const imp = (b: Uint8Array) => subtle.importKey('raw', b as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { c2d: await imp(okm.slice(0, 32)), d2c: await imp(okm.slice(32)) };
}
async function macEqual(auth: Uint8Array, label: string, th: Uint8Array, mac: string) {
    // HMAC verify is constant-time inside WebCrypto.
    let raw: Uint8Array;
    try { raw = unb64u(mac); } catch { return false; }
    return subtle.verify('HMAC', await hmacKey(auth), raw as BufferSource, concat(enc.encode(label), th) as BufferSource);
}

const DIR_C2D = new Uint8Array([0x63, 0x32, 0x64, 0x00]);
const DIR_D2C = new Uint8Array([0x64, 0x32, 0x63, 0x00]);
const MAX_RECORD = 24 * 1024 * 1024;

/** An established session: seal outgoing, open incoming, strictly ordered. */
export class E2ESession {
    private sendCounter = 0n;
    private recvCounter = 0n;
    private sendChain: Promise<unknown> = Promise.resolve();
    private recvChain: Promise<unknown> = Promise.resolve();
    constructor(private sendKey: CryptoKey, private recvKey: CryptoKey, private sendDir: Uint8Array, private recvDir: Uint8Array, private aad: Uint8Array) {}
    private iv(dir: Uint8Array, counter: bigint) {
        const iv = new Uint8Array(12);
        iv.set(dir, 0);
        new DataView(iv.buffer).setBigUint64(4, counter);
        return iv;
    }
    /** Serialized so counters match the order records hit the wire. */
    seal(plain: Uint8Array | string): Promise<Uint8Array> {
        const data = typeof plain === 'string' ? enc.encode(plain) : plain;
        const counter = this.sendCounter++;
        const run = this.sendChain.then(async () => {
            const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: this.iv(this.sendDir, counter) as BufferSource, additionalData: this.aad as BufferSource }, this.sendKey, data as BufferSource));
            const head = new Uint8Array(8);
            new DataView(head.buffer).setBigUint64(0, counter);
            return concat(head, ct);
        });
        this.sendChain = run.catch(() => undefined);
        return run;
    }
    open(record: Uint8Array): Promise<Uint8Array> {
        const run = this.recvChain.then(async () => {
            if (record.length < 8 + 16 || record.length > MAX_RECORD) throw Error('Invalid record');
            const counter = new DataView(record.buffer, record.byteOffset, 8).getBigUint64(0);
            if (counter !== this.recvCounter) throw Error('Replayed or reordered record');
            const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: this.iv(this.recvDir, counter) as BufferSource, additionalData: this.aad as BufferSource }, this.recvKey, record.subarray(8) as BufferSource));
            this.recvCounter++;
            return plain;
        });
        this.recvChain = run.catch(() => undefined);
        return run;
    }
    async openText(record: Uint8Array) { return dec.decode(await this.open(record)); }
}

/** Client side. `start()` -> send hello; `finish(welcome)` -> send confirm, get session. */
export async function clientHandshake(code: string) {
    const auth = await authKey(code);
    const e = await ephemeral();
    const nc = random(16);
    return {
        hello: { t: 'hello', v: E2E_VERSION, pk: b64u(e.pub), n: b64u(nc) },
        async finish(welcome: any) {
            if (welcome?.t !== 'welcome' || welcome.v !== E2E_VERSION) throw Error('Unexpected handshake frame');
            const ed = unb64u(welcome.pk), nd = unb64u(welcome.n);
            if (nd.length !== 16) throw Error('Invalid nonce');
            const th = await transcript(e.pub, ed, nc, nd);
            if (!await macEqual(auth, 'server', th, welcome.mac)) throw Error('Daemon failed authentication (wrong connect code or relay tampering)');
            const keys = await sessionKeys(await agree(e.pair.privateKey, ed), auth, th);
            return {
                confirm: { t: 'confirm', mac: b64u(await hmac(auth, concat(enc.encode('client'), th))) },
                session: new E2ESession(keys.c2d, keys.d2c, DIR_C2D, DIR_D2C, th)
            };
        }
    };
}

/** Daemon side. `accept(hello)` -> send welcome; `verify(confirm)` -> session. */
export async function daemonHandshake(code: string, hello: any) {
    if (hello?.t !== 'hello' || hello.v !== E2E_VERSION) throw Error('Unexpected handshake frame');
    const auth = await authKey(code);
    const ec = unb64u(hello.pk), nc = unb64u(hello.n);
    if (nc.length !== 16) throw Error('Invalid nonce');
    const e = await ephemeral();
    const nd = random(16);
    const th = await transcript(ec, e.pub, nc, nd);
    const keys = await sessionKeys(await agree(e.pair.privateKey, ec), auth, th);
    return {
        welcome: { t: 'welcome', v: E2E_VERSION, pk: b64u(e.pub), n: b64u(nd), mac: b64u(await hmac(auth, concat(enc.encode('server'), th))) },
        async verify(confirm: any) {
            if (confirm?.t !== 'confirm' || !await macEqual(auth, 'client', th, confirm.mac)) throw Error('Client failed authentication');
            return new E2ESession(keys.d2c, keys.c2d, DIR_D2C, DIR_C2D, th);
        }
    };
}
