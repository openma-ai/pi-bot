/** Presentation from public SDK events only. Never inspect a credential or callback URL. */
export function piLoginPresentation(flow: any, placement: 'local' | 'remote' | 'unknown' = 'unknown') {
    const events = flow?.events || [];
    const browser = flow?.type === 'oauth' && ['openai', 'openai-codex'].includes(flow?.providerId)
        && events.some((event: any) => event.type === 'auth_url');
    const fallback = browser && flow?.prompt?.type === 'manual_code';
    const last = events.at(-1);
    const exchanging = browser && last?.type === 'progress';
    if (!flow || flow.status !== 'pending') return { browser, fallback, exchanging: false, spinning: false, title: '' };
    const title = flow.uncertain ? '正在确认登录状态…'
        : flow.starting ? '正在准备登录…'
        : exchanging ? '正在确认授权结果…'
        : events.some((event: any) => event.type === 'device_code') ? '等待你完成设备码授权'
        : browser ? '等待你在浏览器完成登录'
        : flow.prompt?.type === 'select' ? '选择登录方式'
        : flow.prompt ? '填写连接信息' : '正在准备登录…';
    const note = !browser || exchanging ? '' : placement === 'local'
        ? '完成后会自动返回模型选择，无需再填写表单。'
        : placement === 'remote'
            ? '浏览器的本机回调不会自动到达远端运行环境。可使用设备码登录，或展开备用输入。'
            : '浏览器与运行环境在同一台机器时可自动回调；跨设备可使用设备码或备用输入。';
    return { browser, fallback, exchanging, title, note,
        spinning: !!flow.uncertain || !!flow.starting || exchanging || browser || events.some((event: any) => event.type === 'device_code') || !flow.prompt };
}
export function piProviderConfigured(provider: any) {
    return provider?.configured ?? !!provider?.credential;
}
export function piCatalogNote(catalog: any) {
    if (catalog?.source === 'openai-account') {
        if (catalog.accountAccess !== 'confirmed') return '暂时无法读取当前 ChatGPT 账号的模型列表，请重新检查。';
        const unsupported = catalog.unsupportedModelCount ? `其中 ${catalog.unsupportedModelCount} 个型号需要更新模型 SDK 后才能使用。` : '';
        return '已读取当前 ChatGPT 账号的模型列表；实际调用仍受方案与用量限制。' + unsupported;
    }
    if (!catalog) return '运行环境未提供目录刷新状态；账号的逐模型访问权限未经验证。';
    if (catalog.status === 'failed' || catalog.status === 'partial')
        return '模型目录刷新未完成，以下为 SDK 已缓存的目录；账号的逐模型访问权限未经验证。';
    return catalog.status === 'refreshed'
        ? '来自 Pi SDK 刷新后的模型目录（可能使用有效缓存）；不代表账号拥有每个模型的访问权限。'
        : '来自 Pi SDK 缓存目录；账号的逐模型访问权限未经验证。';
}
