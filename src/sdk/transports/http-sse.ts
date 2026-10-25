import type { RpcTransport } from './types.ts';
import { refreshBrowserCsrf } from '../browser-session.ts';
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
            this.csrf = await refreshBrowserCsrf(this.baseUrl, this.fetchImpl);
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
        const send = () => this.fetchImpl(this.baseUrl + '/rpc', {
            method: 'POST', headers: {
                ...this.headers(), 'content-type': 'application/json'
            }, body: JSON.stringify(frame), credentials: 'same-origin', signal: AbortSignal.timeout(30000)
        });
        let r = await send();
        if (r.status === 401) {
            await this.refreshAuth();
            r = await send();
        }
        if(r.status===401||r.status===403)throw Object.assign(Error('Service session expired or revoked ('+r.status+')'),{reason:'authenticationRequired',retryable:false});
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
