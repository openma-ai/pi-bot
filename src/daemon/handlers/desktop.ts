import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';
import { PiBotError } from '../core/errors.ts';
export async function desktopHandler(d: PiBotDaemon, c: DaemonConnection, method: string, p: any): Promise<any> {
    const r = d.runtime, s = r.store;
    switch (method) {
        case 'desktop/capabilities':
            if (p.botId) d.required('bots', p.botId);
            return d.desktop ? d.desktop.capabilities(p.botId, p.refresh) : d.desktopCapabilities;
        case 'desktop/bind':
        case 'desktop/control':
            d.required('bots', p.botId);
            if (!d.desktop)
                throw new PiBotError('setupRequired', 'Desktop is not connected');
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
}
