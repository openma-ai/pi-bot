const sessions = new Map<string, string>();
const origin = (baseUrl: string) => {
    try {
        return new URL(baseUrl || '/', typeof location === 'undefined' ? 'http://localhost' : location.origin).origin;
    }
    catch {
        return baseUrl;
    }
};
export function browserCsrf(baseUrl = '') {
    return sessions.get(origin(baseUrl)) ?? (typeof document === 'undefined' ? '' : document.querySelector<HTMLMetaElement>('meta[name="pibot-csrf"]')?.content ?? '');
}
/** Session nonce only; never model credentials. One bounded bootstrap after auth rejection. */
export async function refreshBrowserCsrf(baseUrl = '', fetchImpl = globalThis.fetch.bind(globalThis)) {
    // Browser sessions belong to the GUI host, not the active runtime route.
    // The route deliberately has no static bootstrap and may already be retired.
    const bootstrap = new URL('/', new URL(baseUrl || '/', typeof location === 'undefined' ? 'http://localhost' : location.origin)).href;
    const response = await fetchImpl(bootstrap, {
        credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000)
    });
    const html = response.ok ? await response.text() : '';
    const csrf = html.match(/name="pibot-csrf" content="([a-f0-9]+)"/)?.[1];
    if (!csrf)
        throw Error('网页会话未恢复，请重新打开页面');
    sessions.set(origin(baseUrl), csrf);
    return csrf;
}
