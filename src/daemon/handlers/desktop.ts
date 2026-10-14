import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';
import { PiBotError } from '../core/errors.ts';
export async function desktopHandler(d: PiBotDaemon, c: DaemonConnection, method: string, p: any): Promise<any> {
    const r = d.runtime, s = r.store;
    switch (method) {
        case 'desktop/bind':
        case 'desktop/control':
            d.required('bots', p.botId);
            if (!d.desktop)
                throw new PiBotError('setupRequired', 'Desktop is not connected');
            return (await d.desktop.request(method === 'desktop/bind' ? '/bind' : '/control', p)).json();
    }
}
