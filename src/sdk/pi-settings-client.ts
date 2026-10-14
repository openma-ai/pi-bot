/** Private credential form transport, deliberately separate from JSON-RPC and event logging. */
import { browserCsrf, refreshBrowserCsrf } from './browser-session.ts';
export function createPiSettingsClient(baseUrl = '', headers: () => Record<string, string> = () => ({
    'X-PiBot-CSRF': browserCsrf(baseUrl)
})) {
    return async (path: string, body?: unknown) => {
        const send = () => fetch(baseUrl + '/pi/' + path, {
            method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : {
                'content-type': 'application/json', ...headers()
            }, ...(body === undefined ? {} : {
                body: JSON.stringify(body)
            }), signal: AbortSignal.timeout(30000), ...(body === undefined ? {
                headers: headers()
            } : {})
        });
        let response = await send();
        if (response.status === 401 && !headers().authorization) {
            await refreshBrowserCsrf(baseUrl);
            response = await send();
        }
        const value = await response.json();
        if (!response.ok)
            throw new Error(value.error ?? 'Pi 操作失败');
        return value;
    };
}
export const piSettingsRequest = createPiSettingsClient();
