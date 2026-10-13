import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** Explicit opt-in host-only bridge. Never imports DSH sessions, profiles or an agent. */
export async function readLocalDshDeepSeekKey(path = join(homedir(), '.dsh', '.credentials.yaml')): Promise<string> {
    let bytes: Buffer | undefined;
    let raw = '';
    try {
        bytes = await readFile(path);
        raw = bytes.toString('utf8');
        const matches = [...raw.matchAll(/^\s*DEEPSEEK_API_KEY:\s*([^\r\n]+)$/gm)];
        if (matches.length !== 1)
            throw Error('unavailable');
        let value = matches[0]![1]!.trim();
        if (value.startsWith('"'))
            value = JSON.parse(value);
        else if (value.startsWith("'") && value.endsWith("'"))
            value = value.slice(1, -1).replaceAll("''", "'");
        if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{8,16384}$/.test(value))
            throw Error('unavailable');
        return value;
    }
    catch {
        throw Error('Local DeepSeek credential unavailable');
    }
    finally {
        bytes?.fill(0);
        raw = '';
    }
}
