import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Evaluator metadata and executable scratch files stay inside this checkout. */
export async function createEvaluationDirectory(prefix: string): Promise<string> {
    if (!/^[a-z-]{1,80}$/.test(prefix))
        throw Error('Invalid evaluation directory prefix');
    const base = fileURLToPath(new URL('../work/behavior-runtime/', import.meta.url));
    await mkdir(base, {
        recursive: true, mode: 0o700
    });
    return await mkdtemp(join(base, prefix));
}
