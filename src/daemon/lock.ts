import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
/** One local host per DB. Not a distributed/NFS lock. Never steal a live/unknown PID. */
export function acquireLock(database: string) {
    const path = resolve(database) + '.lock';
    mkdirSync(dirname(path), {
        recursive: true
    });
    for (let tries = 0; tries < 2; tries++) {
        try {
            const fd = openSync(path, 'wx', 0o600);
            writeFileSync(fd, String(process.pid));
            closeSync(fd);
            return () => {
                try {
                    if (readFileSync(path, 'utf8') === String(process.pid))
                        unlinkSync(path);
                }
                catch {
                }
            };
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                throw error;
            const pid = Number(readFileSync(path, 'utf8'));
            if (!Number.isInteger(pid) || pid <= 0)
                throw Error('Invalid runtime lock; inspect before removing');
            try {
                process.kill(pid, 0);
                throw Error(`Runtime database already owned by live process ${pid}`);
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
                    throw e;
            }
            unlinkSync(path);
        }
    }
    throw Error('Could not acquire runtime lock');
}
