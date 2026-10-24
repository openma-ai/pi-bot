export function connectionIssue(error, profile, nodeState) {
    const raw = String(error?.message || error || '连接没有完成');
    if (profile?.embeddedTailscale && (/先授权|准备内嵌|未启用 embedded|重新授权/.test(raw) || ['notPrepared', 'stopped'].includes(nodeState)))
        return {
            title: '先授权这台设备', detail: '应用内网络还没有准备好。返回连接信息，在浏览器登录并批准 Pibo；这不会替远程电脑登录。', kind: 'app-auth'
        };
    if (/凭据|密码|认证|Keychain|privateKey/.test(raw))
        return {
            title: '检查登录信息', detail: '请检查服务访问密码，或重新登录以恢复已过期或撤销的会话。', kind: 'credentials'
        };
    if (profile?.embeddedTailscale && /Tailnet|ACL|tailnet|网络/.test(raw))
        return {
            title: '暂时无法到达远程电脑', detail: '应用授权、远端登录与网络访问权限是不同步骤。远程电脑是否已登录同一 Tailscale 网络目前无法确认，请检查后重试。', kind: 'network'
        };
    if (/runtime|独立启动|服务/i.test(raw))
        return {
            title: '没有找到运行中的工作空间', detail: '请确认 Pibo 服务已在目标电脑独立启动，并核对服务数据目录。无需更改系统 VPN 或代理。', kind: 'service'
        };
    return {
        title: '连接没有完成', detail: '检查地址、网络与登录信息后重试，也可以返回修改连接配置。', kind: 'connection'
    };
}
export function usableProfiles(profiles = []) {
    return profiles.filter(p => p.mode === 'tailnet' || p.mode === 'direct' || p.mode === 'local' && p.dataDir && !p.dataDir.startsWith('/path/to/') && p.dataDir !== '/path/to/existing/pi-bot/data');
}
