/**
 * Paired-device registry for the daemon's HTTP API (local and relay alike).
 * Persisted at <dataDir>/remote-access.json (0600). Only SHA-256 hashes of
 * device tokens are stored; tokens, tickets and the connect code are never logged.
 */
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { generateConnectCode } from '../../sdk/protocol/remote-e2e.ts';

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const TOKEN = /^pbd_[A-Za-z0-9_-]{43}$/;
// Crockford base32 without I/L/O/U; 10 symbols = 50 bits, single use, 5 attempts, 10 min.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const TICKET_TTL_MS = 10 * 60 * 1000;
const MAX_DEVICES = 64;

export interface Device { name: string; hash: string; createdAt: string; lastSeenAt?: string; via: 'pair' | 'invite' | 'provisioned'; invitedBy?: string }
interface State { version: 1; code: string; codeGeneration: number; secret: string; devices: Record<string, Device>; revokedHashes: string[] }

export const normalizeTicket = (s: string) => String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
export const formatTicket = (t: string) => t.slice(0, 5) + '-' + t.slice(5);
const newToken = () => 'pbd_' + randomBytes(32).toString('base64url');

export class DeviceRegistry {
    private state: State;
    private file: string;
    private ticket: { hash: string; expires: number; attempts: number; issuedBy?: string } | undefined;
    constructor(dataDir: string) {
        this.file = join(dataDir, 'remote-access.json');
        let s: State | undefined;
        try { s = JSON.parse(readFileSync(this.file, 'utf8')); }
        catch (e: any) { if (e.code !== 'ENOENT') throw Error('Invalid remote-access store'); }
        if (s && (s.version !== 1 || typeof s.code !== 'string' || typeof s.secret !== 'string' || !s.devices || typeof s.devices !== 'object'))
            throw Error('Invalid remote-access store');
        this.state = s ?? { version: 1, code: generateConnectCode(), codeGeneration: 1, secret: randomBytes(32).toString('hex'), devices: {}, revokedHashes: [] };
        if (!s) this.persist();
    }
    private persist() {
        const tmp = this.file + '.' + randomBytes(6).toString('hex');
        writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600, flag: 'wx' });
        renameSync(tmp, this.file);
    }
    get connectCode() { return this.state.code; }
    get codeGeneration() { return this.state.codeGeneration; }
    /** Invalidates the old QR/link/route: every device must re-pair via a new code. */
    rotateConnectCode() {
        this.state.code = generateConnectCode();
        this.state.codeGeneration++;
        this.ticket = undefined;
        this.persist();
        return this.state.codeGeneration;
    }
    /** New one-time ticket; supersedes any outstanding one. */
    issueTicket(issuedBy?: string) {
        let t = '';
        for (const b of randomBytes(10)) t += ALPHABET[b & 31];
        this.ticket = { hash: digest(t), expires: Date.now() + TICKET_TTL_MS, attempts: 0, issuedBy };
        return { ticket: t, display: formatTicket(t), expiresAt: this.ticket.expires };
    }
    cancelTicket() { this.ticket = undefined; }
    claim(ticket: unknown, name: unknown): { deviceId: string; token: string } | 'closed' | 'invalid' | 'full' {
        const p = this.ticket;
        if (!p || p.expires <= Date.now() || p.attempts >= 5) { this.ticket = undefined; return 'closed'; }
        p.attempts++;
        if (typeof ticket !== 'string' || !same(p.hash, digest(normalizeTicket(ticket)))) return 'invalid';
        if (Object.keys(this.state.devices).length >= MAX_DEVICES) return 'full';
        this.ticket = undefined;
        return this.add(String(name ?? 'device').slice(0, 64) || 'device', p.issuedBy ? 'invite' : 'pair', p.issuedBy);
    }
    private add(name: string, via: Device['via'], invitedBy?: string, token = newToken()) {
        const id = randomBytes(8).toString('hex');
        this.state.devices[id] = { name, hash: digest(token), createdAt: new Date().toISOString(), via, ...(invitedBy ? { invitedBy } : {}) };
        this.persist();
        return { deviceId: id, token };
    }
    /** CI / automation: register an externally supplied token (env/file). Idempotent; revoked tokens stay revoked. */
    provision(token: string, name = 'provisioned') {
        if (!TOKEN.test(token)) throw Error('Provisioned token must match pbd_<43 base64url chars>');
        const hash = digest(token);
        if (this.state.revokedHashes.includes(hash)) return undefined;
        const existing = Object.entries(this.state.devices).find(([, d]) => d.hash === hash);
        if (existing) return existing[0];
        return this.add(name, 'provisioned', undefined, token).deviceId;
    }
    /** New provisioned token generated by the daemon (printed once by the CLI). */
    createProvisioned(name: string) { return this.add(name.slice(0, 64) || 'provisioned', 'provisioned'); }
    authenticate(token: string | undefined): string | undefined {
        if (!token || !TOKEN.test(token)) return undefined;
        const hash = digest(token);
        const hit = Object.entries(this.state.devices).find(([, d]) => same(d.hash, hash));
        if (!hit) return undefined;
        const now = new Date().toISOString();
        if (!hit[1].lastSeenAt || Date.parse(now) - Date.parse(hit[1].lastSeenAt) > 60000) { hit[1].lastSeenAt = now; try { this.persist(); } catch { /* best effort */ } }
        return hit[0];
    }
    rotateToken(id: string) {
        const d = this.state.devices[id];
        if (!d) return undefined;
        const token = newToken();
        this.state.revokedHashes.push(d.hash);
        d.hash = digest(token);
        this.persist();
        return token;
    }
    revoke(id: string) {
        const d = this.state.devices[id];
        if (!d) return false;
        this.state.revokedHashes.push(d.hash);
        if (this.state.revokedHashes.length > 1024) this.state.revokedHashes.splice(0, this.state.revokedHashes.length - 1024);
        delete this.state.devices[id];
        this.persist();
        for (const fn of this.listeners) fn(id);
        return true;
    }
    private listeners = new Set<(id: string) => void>();
    onRevoke(fn: (id: string) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    exists(id: string) { return !!this.state.devices[id]; }
    list() {
        return Object.entries(this.state.devices).map(([id, d]) => ({ id, name: d.name, via: d.via, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, invitedBy: d.invitedBy }));
    }
    /** Per-device CSRF value for cookie-authenticated browsers. */
    csrf(id: string) { return createHmac('sha256', this.state.secret).update('csrf:' + id).digest('hex'); }
}
