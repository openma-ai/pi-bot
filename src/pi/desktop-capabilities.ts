/** Public, credential-free state shared by the harness, UI and agent tools. */
export type CapabilityState = 'unsupported' | 'unconfigured' | 'permission-required' | 'unreachable' | 'ready' | 'unknown';
export type DesktopCapability = { state: CapabilityState; reason: string; checkedAt: number };
export type DesktopCapabilities = {
    configured: boolean;
    canOpenView: boolean;
    platform: string;
    browser: DesktopCapability;
    computerUse: DesktopCapability;
    screenCapture: DesktopCapability;
    vnc: DesktopCapability;
    availableTools: { browser: string[]; computer: string[] };
};
export type DesktopCapabilityKind = 'browser' | 'computerUse' | 'screenCapture' | 'vnc';
export const capability = (state: CapabilityState, reason: string, checkedAt = Date.now()): DesktopCapability => ({ state, reason, checkedAt });
export function unavailableDesktopCapabilities(platform: string = process.platform, configured = false, state: CapabilityState = 'unconfigured', reason = 'No desktop companion is configured'): DesktopCapabilities {
    const item = capability(state, reason);
    return { configured, canOpenView: false, platform, browser: item, computerUse: item, screenCapture: item, vnc: item, availableTools: { browser: [], computer: [] } };
}
export function unconfiguredDesktopCapabilities(platform: string = process.platform): DesktopCapabilities {
    const result = unavailableDesktopCapabilities(platform);
    if (platform !== 'linux') {
        result.computerUse = capability('unsupported', 'This harness has no native Computer Use adapter for this platform; a configured Linux desktop companion is supported');
        result.screenCapture = capability('unknown', platform === 'darwin' ? 'macOS Screen Recording and Accessibility permissions have not been probed' : 'Native screen capture has not been probed');
    }
    return result;
}
export function isDesktopCapabilities(value: unknown): value is DesktopCapabilities {
    const v = value as DesktopCapabilities | undefined;
    const states: CapabilityState[] = ['unsupported', 'unconfigured', 'permission-required', 'unreachable', 'ready', 'unknown'];
    return !!v && typeof v.configured === 'boolean' && typeof v.canOpenView === 'boolean' && typeof v.platform === 'string'
        && (['browser', 'computerUse', 'screenCapture', 'vnc'] as const).every(key => {
            const c = v[key];
            return c && states.includes(c.state) && typeof c.reason === 'string' && c.reason.length <= 1000 && Number.isSafeInteger(c.checkedAt) && c.checkedAt >= 0;
        }) && !!v.availableTools && ['browser', 'computer'].every(key => {
            const list = v.availableTools[key as 'browser' | 'computer'];
            return Array.isArray(list) && list.length <= 40 && list.every(name => typeof name === 'string' && name.length <= 100);
        });
}
/** A faulty probe cannot hold a chat turn or a snapshot open indefinitely. */
export async function boundedProbe<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Capability probe timed out')), timeoutMs);
        })]);
    } finally { clearTimeout(timer); }
}
