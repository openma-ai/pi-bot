import type { ReadStream, WriteStream } from 'node:tty';
import { CredentialBroker, type CredentialScope } from './runtime/credentials.ts';
/** Direct local terminal input. Raw mode disables echo. No readline/history,
 * argv/env/file value, masks, or pasted chat credentials are accepted. */
export async function readHidden(label: string, input: ReadStream = process.stdin, output: WriteStream = process.stderr): Promise<string> {
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function')
        throw Error('Hidden credential entry requires a local interactive TTY');
    if (!/^[a-zA-Z0-9 _.-]{1,80}$/.test(label))
        throw Error('Invalid credential label');
    const previousRaw = input.isRaw;
    const previouslyFlowing = input.readableFlowing === true;
    const bytes: number[] = [];
    output.write(`${label} (hidden; Enter submits, Ctrl-C cancels): `);
    input.setRawMode(true);
    input.resume();
    return await new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
            if (settled)
                return;
            settled = true;
            input.off('data', onData);
            input.off('end', onEnd);
            input.off('error', onError);
            input.setRawMode(previousRaw);
            if (!previouslyFlowing)
                input.pause();
            output.write('\n');
            if (error) {
                bytes.fill(0);
                reject(error);
            }
            else {
                const secret = Buffer.from(bytes).toString('utf8');
                bytes.fill(0);
                resolve(secret);
            }
        };
        const onEnd = () => finish(Error('Credential entry closed'));
        const onError = () => finish(Error('Credential entry failed'));
        const onData = (chunk: Buffer | string) => {
            const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            for (const byte of data) {
                if (byte === 3 || byte === 4) {
                    finish(Error('Credential entry cancelled'));
                    break;
                }
                if (byte === 10 || byte === 13) {
                    finish(bytes.length ? undefined : Error('Credential entry empty'));
                    break;
                }
                if (byte === 127 || byte === 8) {
                    bytes.pop();
                    continue;
                }
                if (byte < 32) {
                    finish(Error('Credential entry control sequence rejected'));
                    break;
                }
                if (bytes.length >= 16384) {
                    finish(Error('Credential entry too large'));
                    break;
                }
                bytes.push(byte);
            }
            // Node Buffer is mutable; raw incoming credential bytes are cleared.
            if (Buffer.isBuffer(chunk))
                chunk.fill(0);
        };
        input.on('data', onData);
        input.once('end', onEnd);
        input.once('error', onError);
    });
}
export async function enterCredential(broker: CredentialBroker, scope: CredentialScope, label: string) {
    const form = broker.request(scope, label);
    try {
        return broker.submit(form.requestId, scope, await readHidden(label));
    }
    catch {
        broker.revoke(form.requestId);
        throw Error('Credential entry did not complete');
    }
}
