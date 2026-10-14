import type { RpcTransport } from './types.ts';
export class HttpSseTransport implements RpcTransport {
    private connection = '';
    private stream?: AbortController;
    constructor(readonly baseUrl = '', private token?: string, private fetchImpl = globalThis.fetch.bind(globalThis), private csrf?: string, private auth?: () => Promise<{
        token?: string;
        csrf?: string;
    }>) {
    }
    async refreshAuth() {
        if (this.auth) {
            const fresh = await this.auth();
            this.token = fresh.token;
            this.csrf = fresh.csrf;
            return;
        }
        if (this.token === undefined) {
            const response = await this.fetchImpl(this.baseUrl + '/', {
                credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000)
            });
            if (!response.ok)
                throw Error('Browser session unavailable');
            const html = await response.text();
            const csrf = html.match(/name="pibot-csrf" content="([a-f0-9]+)"/)?.[1];
            if (!csrf)
                throw Error('Browser session unavailable');
            this.csrf = csrf;
        }
    }
    headers() {
        return {
            ...(this.token ? {
                authorization: 'Bearer ' + this.token
            } : {}), ...(!this.token && this.csrf ? {
                'X-PiBot-CSRF': this.csrf
            } : {}), 'X-PiBot-Connection': this.connection
        };
    }
    setConnection(id: string) {
        this.connection = id;
    }
    async request(frame: any) {
        const r = await this.fetchImpl(this.baseUrl + '/rpc', {
            method: 'POST', headers: {
                ...this.headers(), 'content-type': 'application/json'
            }, body: JSON.stringify(frame), credentials: 'same-origin', signal: AbortSignal.timeout(30000)
        });
        if (!r.ok)
            throw Error('Daemon connection rejected (' + r.status + ')');
        return r.status === 204 ? undefined : r.json();
    }
    listen(receive: (frame: any) => void, disconnected?: (error?: unknown) => void) {
        this.stream?.abort();
        const abort = new AbortController();
        this.stream = abort;
        void (async () => {
            try {
                const response = await this.fetchImpl(this.baseUrl + '/events?connection=' + encodeURIComponent(this.connection), {
                    headers: this.headers(), credentials: 'same-origin', signal: abort.signal
                });
                if (!response.ok || !response.body)
                    throw Error('Event stream unavailable');
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                while (!abort.signal.aborted) {
                    const next = await reader.read();
                    if (next.done)
                        break;
                    buffer += decoder.decode(next.value, {
                        stream: true
                    });
                    let boundary;
                    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                        const block = buffer.slice(0, boundary);
                        buffer = buffer.slice(boundary + 2);
                        const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
                        if (data)
                            receive(JSON.parse(data));
                    }
                }
                if (!abort.signal.aborted)
                    disconnected?.();
            }
            catch (e) {
                if (!abort.signal.aborted)
                    disconnected?.(e);
            }
        })();
        return () => abort.abort();
    }
    close() {
        this.stream?.abort();
    }
}
