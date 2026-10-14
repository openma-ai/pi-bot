import { Value } from 'typebox/value';
import type { Static } from 'typebox';
import { clientRuntimeMethods } from './protocol/client-runtime.ts';
import { browserCsrf, refreshBrowserCsrf } from './browser-session.ts';
type Method = keyof typeof clientRuntimeMethods;
type Call<M extends Method> = (params: Static<(typeof clientRuntimeMethods)[M]['params']>) => Promise<Static<(typeof clientRuntimeMethods)[M]['result']>>;
export class RuntimeClient {
    private id = 0;
    private csrf?: string;
    readonly runtime: {
        status: Call<'runtime/status'>;
        connect: Call<'runtime/connect'>;
        configure: Call<'runtime/configure'>;
        disconnect: Call<'runtime/disconnect'>;
        remove: Call<'runtime/remove'>;
    };
    constructor(readonly baseUrl = '', private headers: () => Record<string, string> = () => ({
        'X-PiBot-CSRF': browserCsrf(baseUrl)
    }), private fetchImpl = globalThis.fetch.bind(globalThis)) {
        this.runtime = {
            status: p => this.call('runtime/status', p), connect: p => this.call('runtime/connect', p), configure: p => this.call('runtime/configure', p), disconnect: p => this.call('runtime/disconnect', p), remove: p => this.call('runtime/remove', p)
        };
    }
    private async call<M extends Method>(method: M, params: unknown): Promise<Static<(typeof clientRuntimeMethods)[M]['result']>> {
        const schema = clientRuntimeMethods[method];
        if (!Value.Check(schema.params, params))
            throw Error('请检查连接配置');
        const frame = JSON.stringify({
            jsonrpc: '2.0', id: ++this.id, method, params
        });
        const send = () => this.fetchImpl(this.baseUrl + '/client/rpc', {
            method: 'POST', credentials: 'same-origin', headers: {
                ...this.headers(), ...(this.csrf ? {
                    'X-PiBot-CSRF': this.csrf
                } : {}), 'content-type': 'application/json'
            }, body: frame, signal: AbortSignal.timeout(45000)
        });
        let response: Response;
        try {
            response = await send();
        }
        catch {
            // A restarted host can reset an HTTP keep-alive socket before returning
            // 401. Only the read-only status call may be retried after that ambiguity.
            if (method !== 'runtime/status')
                throw Error('连接中断，请检查 runtime 当前状态后重试');
            if (!this.headers().authorization)
                this.csrf = await refreshBrowserCsrf(this.baseUrl, this.fetchImpl);
            response = await send();
        }
        if (response.status === 401 && !this.headers().authorization) {
            this.csrf = await refreshBrowserCsrf(this.baseUrl, this.fetchImpl);
            response = await send();
        }
        if (!response.ok)
            throw Object.assign(Error(response.status === 404 ? '请使用 client 命令启动连接设置' : '无法连接客户端服务'), {
                status: response.status
            });
        const reply = await response.json();
        if (reply.error)
            throw Error(reply.error.message);
        if (!Value.Check(schema.result, reply.result))
            throw Error('连接设置响应不兼容');
        return reply.result;
    }
}
