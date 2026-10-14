import type { RpcTransport } from './types.ts';
/** Node/editor adapters provide line IO; this protocol implementation stays browser-safe. */
export class StdioTransport implements RpcTransport {
    private pending = new Map<string | number, {
        resolve: (frame: any) => void;
        reject: (error: unknown) => void;
    }>();
    private receive?: (frame: any) => void;
    private stop: () => void;
    constructor(readonly io: {
        write(line: string): void;
        onLine(receive: (line: string) => void): () => void;
        close(): void;
    }) {
        this.stop = io.onLine(line => {
            const frame = JSON.parse(line);
            const waiter = this.pending.get(frame.id);
            if (waiter) {
                this.pending.delete(frame.id);
                waiter.resolve(frame);
            }
            else
                this.receive?.(frame);
        });
    }
    request(frame: any) {
        if (frame.id === undefined) {
            this.io.write(JSON.stringify(frame) + '\n');
            return Promise.resolve(undefined);
        }
        return new Promise((resolve, reject) => {
            this.pending.set(frame.id, {
                resolve, reject
            });
            this.io.write(JSON.stringify(frame) + '\n');
        });
    }
    listen(receive: (frame: any) => void) {
        this.receive = receive;
        return () => {
            this.receive = undefined;
        };
    }
    close() {
        this.stop();
        this.io.close();
        for (const waiter of this.pending.values())
            waiter.reject(Error('Stdio transport closed'));
        this.pending.clear();
    }
}
