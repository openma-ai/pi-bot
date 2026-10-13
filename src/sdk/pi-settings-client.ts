/** Private credential form transport, deliberately separate from JSON-RPC and event logging. */
export async function piSettingsRequest(path: string, body?: unknown) {
    const csrf = document.querySelector<HTMLMetaElement>('meta[name="pibot-csrf"]')?.content ?? '';
    const response = await fetch('/pi/' + path, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : {
            'content-type': 'application/json', 'X-PiBot-CSRF': csrf
        }, ...(body === undefined ? {} : {
            body: JSON.stringify(body)
        })
    });
    const value = await response.json();
    if (!response.ok)
        throw new Error(value.error ?? 'Pi 操作失败');
    return value;
}
