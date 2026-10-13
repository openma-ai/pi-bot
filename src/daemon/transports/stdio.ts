import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import type { PiBotDaemon } from '../core/daemon.ts';
export function listenStdio(daemon: PiBotDaemon, input: Readable = process.stdin, output: Writable = process.stdout) {
    const decoder = new StringDecoder('utf8');
    const c = daemon.connect('stdio');
    let buffer = '', blocked = false, chain = Promise.resolve();
    const send = (frame: any) => {
        if (blocked)
            return false;
        blocked = !output.write(JSON.stringify(frame) + '\n');
        return true;
    };
    const detach = c.attach(send);
    output.on('drain', () => {
        blocked = false;
        c.flush();
    });
    const receive = (bytes: Buffer) => {
        buffer += decoder.write(bytes);
        if (Buffer.byteLength(buffer) > 1024 * 1024 && !buffer.includes('\n')) {
            c.close('messageTooLarge');
            input.destroy();
            return;
        }
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, i);
            buffer = buffer.slice(i + 1);
            if (!line.trim())
                continue;
            chain = chain.then(async () => {
                let frame;
                try {
                    frame = JSON.parse(line);
                }
                catch {
                    c.push({
                        id: null, error: {
                            code: -32700, message: 'Parse error', data: {
                                reason: 'invalidParams', retryable: false
                            }
                        }
                    });
                    return;
                }
                const result = await c.request(frame);
                if (result)
                    c.push(result);
            });
        }
    };
    input.on('data', receive);
    input.on('end', () => void chain.then(() => daemon.close()));
    return {
        connection: c, close() {
            input.off('data', receive);
            detach();
            c.close();
        }
    };
}
