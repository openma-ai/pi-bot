/** Private credential form transport, deliberately separate from JSON-RPC and event logging. */
import { browserCsrf, refreshBrowserCsrf } from './browser-session.ts';
export class PiSettingsRequestError extends Error {
    constructor(message: string, readonly code: string, readonly submitted = false, readonly status?: number) {
        super(message);
        this.name = 'PiSettingsRequestError';
    }
}
export function createPiSettingsClient(baseUrl = '', headers: () => Record<string, string> = () => ({ 'X-PiBot-CSRF': browserCsrf(baseUrl) })) {
    return async (path: string, body?: unknown) => {
        const submitted = body !== undefined;
        const send = () => fetch(baseUrl + '/pi/' + path, {
            method: submitted ? 'POST' : 'GET', credentials: 'same-origin',
            headers: { ...headers(), ...(submitted ? { 'content-type': 'application/json' } : {}) },
            ...(submitted ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000)
        });
        let response: Response;
        try {
            response = await send();
            // A rejected authentication check cannot have executed the operation.
            if (response.status === 401 && !headers().authorization) {
                await refreshBrowserCsrf(baseUrl);
                response = await send();
            }
        } catch {
            // Never replay login or model writes after an ambiguous network failure.
            throw new PiSettingsRequestError(submitted ? '连接中断，操作结果尚未确认' : '无法连接网页客户端', 'connectionLost', submitted);
        }
        if (response.status === 410) throw new PiSettingsRequestError('运行环境已切换，请重新加载设置', 'runtimeChanged', submitted, 410);
        if ([502, 503, 504].includes(response.status)) throw new PiSettingsRequestError(submitted ? '连接中断，操作结果尚未确认' : '无法连接当前 runtime', 'connectionLost', submitted, response.status);
        const value = await response.json().catch(() => { throw new PiSettingsRequestError('暂时无法读取 Pi 设置', 'invalidResponse', submitted, response.status); });
        if (!response.ok) throw new PiSettingsRequestError(typeof value.error === 'string' ? value.error : 'Pi 操作未完成', 'requestRejected', submitted, response.status);
        return value;
    };
}
export const piSettingsRequest = createPiSettingsClient();
