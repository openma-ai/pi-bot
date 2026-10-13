import { createHash, randomBytes } from 'node:crypto';
export function uuid7(prefix: string) {
    const b = randomBytes(16);
    b.writeUIntBE(Date.now(), 0, 6);
    b[6] = (b[6] & 15) | 0x70;
    b[8] = (b[8] & 63) | 0x80;
    const h = b.toString('hex');
    return prefix + h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}
export function threadId(botId: string, scopeKey: string) {
    return 'thr_' + createHash('sha256').update(botId + '\0' + scopeKey).digest('base64url').slice(0, 22);
}
