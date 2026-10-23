import type { WebSocket } from 'ws';
/** Ping the actual viewer, not the broker-side proxy which can outlive it. */
export function watchDesktopViewer(socket: WebSocket, intervalMs = 5000) {
    let missed = 0;
    const pong = () => { missed = 0; };
    socket.on('pong', pong);
    const timer = setInterval(() => {
        if (socket.readyState !== 1 || ++missed > 3) {
            clearInterval(timer);
            socket.terminate();
            return;
        }
        socket.ping();
    }, intervalMs);
    timer.unref();
    socket.once('close', () => { clearInterval(timer); socket.off('pong', pong); });
}
