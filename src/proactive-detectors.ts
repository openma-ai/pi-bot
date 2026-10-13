import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Detector } from './proactive.ts';
/** The host chooses the path. This detector never reads file contents or runs scripts. */
export function createFileChangeDetector(path: string): Detector {
    return async (input) => {
        input.signal.throwIfAborted();
        let fingerprint: string;
        try {
            const s = await stat(path);
            fingerprint = JSON.stringify([s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode]);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                return {
                    decision: 'error', error: 'File metadata unavailable'
                };
            fingerprint = 'absent';
        }
        input.signal.throwIfAborted();
        const changed = input.baseline !== undefined && input.baseline !== fingerprint;
        return {
            decision: changed ? 'wake' : 'silent', baseline: fingerprint, cursor: fingerprint, ...(changed ? {
                dedupKey: createHash('sha256').update(fingerprint).digest('hex'), payload: `Host-allowlisted file metadata changed: ${path}`
            } : {})
        };
    };
}
