import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';
import { PiBotError } from '../core/errors.ts';
export async function desktopHandler(d: PiBotDaemon, c: DaemonConnection, method: string, p: any): Promise<any> {
    const r = d.runtime, s = r.store;
    switch (method) {
        case 'desktop/capabilities':
            if (p.botId) d.required('bots', p.botId);
            if (d.desktop) return d.desktop.capabilities(p.botId, p.refresh);
            if (d.nativeMacosComputerUse) return d.refreshNativeDesktopCapabilities(!!p.refresh);
            return d.desktopCapabilities;
        case 'desktop/bind':
        case 'desktop/control':
            d.required('bots', p.botId);
            if (d.desktop) {
                if (method === 'desktop/bind') {
                    const report = await d.desktop.capabilities(p.botId, true);
                    if (!report.canOpenView) throw new PiBotError('setupRequired', 'Desktop viewer is not available', { desktopCapabilities: report });
                    const result = await (await d.desktop.request('/bind', { ...p, openView: true })).json();
                    void d.desktop.capabilities(undefined, true);
                    return result;
                }
                if (p.take) await d.desktop.assertAvailable('computerUse');
                return (await d.desktop.request('/control', p)).json();
            }
            if (d.nativeMacosComputerUse && d.macosVirtualDisplay) {
                const report = await d.refreshNativeDesktopCapabilities(true);
                if (method === 'desktop/bind') {
                    if (report.computerUse.state !== 'ready') {
                        throw new PiBotError('setupRequired', report.computerUse.reason, { desktopCapabilities: report });
                    }
                    if (!d.macosVirtualDisplay.binaryPath) {
                        throw new PiBotError('setupRequired', 'pi-virtual-display-companion binary missing; run scripts/build-macos-virtual-display.sh', { desktopCapabilities: report });
                    }
                    const binding = await d.macosVirtualDisplay.bind(p.botId, { size: p.size });
                    void d.refreshNativeDesktopCapabilities(true);
                    return {
                        binding,
                        companion: d.macosVirtualDisplay.status.companion,
                        view: 'vnc-tile',
                        isolation: {
                            display: 'companion-cgvirtualdisplay-tiled',
                            input: 'serialized-global-cursor-bound-window-verified',
                            note: 'macOS has one global cursor/focus; input is serialized and aborted unless the frontmost window is the session\'s bound window. Linux X11 isolates input per display.',
                        },
                    };
                }
                // desktop/control on native: takeover makes this session's RFB endpoint interactive.
                if (p.take) {
                    if (report.computerUse.state !== 'ready') throw new PiBotError('setupRequired', report.computerUse.reason, { desktopCapabilities: report });
                    return d.macosVirtualDisplay.takeover(p.botId);
                }
                if (p.view) {
                    const vnc = await d.macosVirtualDisplay.openViewer(p.botId);
                    void d.refreshNativeDesktopCapabilities(true);
                    return { vnc };
                }
                if (p.release) {
                    await d.macosVirtualDisplay.release(p.botId);
                    return { released: true };
                }
                if (p.handBack) {
                    d.macosVirtualDisplay.releaseControl(p.botId);
                    return { handedBack: true };
                }
                return d.macosVirtualDisplay.owners.control() ?? null;
            }
            throw new PiBotError('setupRequired', 'Desktop is not connected');
    }
}
