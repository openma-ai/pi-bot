/** Public connection metadata only. Never resolve or copy a credential in the UI. */
export function piConnections(config: any): any[] {
    if (Array.isArray(config?.connections)) return config.connections;
    return (config?.providers || []).filter((p: any) => p.configured || p.credential).map((p: any) => ({
        ...p, id: `legacy:${p.id}`, providerId: p.id, legacy: true
    }));
}
export function currentConnectionId(config: any) {
    return config?.current?.connectionId || (config?.current?.provider ? `legacy:${config.current.provider}` : '');
}
export function piModelOptions(config: any) {
    return piConnections(config).filter(c => c.configured).flatMap(c => (c.models || []).map((m: any) => ({
        id: JSON.stringify([c.id, m.id]), name: m.name || m.id,
        detail: `${c.name} · ${m.id}`, connectionId: c.id, provider: c.providerId, model: m.id
    })));
}
export function endpointInputError(value: string): string | undefined {
    try {
        if (!value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return '请输入完整服务地址';
        if (/[\\?#]/.test(value) || /%(?:2f|5c|2e)/i.test(value) || /\/(?:\.{1,2})(?:\/|$)/.test(value)) return '地址必须是无查询参数的完整服务路径';
        const url = new URL(value.trim());
        if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) return '仅支持 HTTP(S) 服务地址';
        if (url.username || url.password || url.search || url.hash) return '地址不能包含用户名、密码、查询参数或片段';
        if (/\/{2}/.test(url.pathname)) return '请检查服务路径中的重复斜杠';
        return undefined;
    } catch { return '请输入有效的完整 HTTP(S) 地址'; }
}
