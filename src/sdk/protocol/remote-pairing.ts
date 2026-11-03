/** Pairing link format shared by daemon and clients: `pibot://pair#<base64url JSON>`. */
import { b64u, unb64u } from './remote-e2e.ts';

export interface PairingPayload {
    v: 1;
    /** Relay origin, e.g. https://alma-relay.example.workers.dev. Absent for local-only pairing. */
    relay?: string;
    /** Connect code (E2E handshake secret). Never sent to the relay. */
    code?: string;
    /** One-time pairing ticket (also shown as the short manual code). */
    ticket: string;
    /** Daemon display name. */
    name?: string;
}
const PREFIX = 'pibot://pair#';
export function encodePairingLink(p: PairingPayload) {
    return PREFIX + b64u(new TextEncoder().encode(JSON.stringify(p)));
}
export function decodePairingLink(link: string): PairingPayload {
    const raw = link.trim();
    if (!raw.startsWith(PREFIX)) throw Error('Not a pi-bot pairing link');
    const p = JSON.parse(new TextDecoder().decode(unb64u(raw.slice(PREFIX.length))));
    if (p?.v !== 1 || typeof p.ticket !== 'string') throw Error('Unsupported pairing payload');
    return p;
}

