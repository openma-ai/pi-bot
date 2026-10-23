export interface DesktopBinding {
    botId: string;
    screen: number;
    targetId: string;
    windowId: number;
    x: number;
    y: number;
    width: number;
    height: number;
}
export class DesktopOwnership {
    readonly bindings = new Map<string, DesktopBinding>();
    private viewers = new Map<string, string>();
    claimViewer(botId: string, viewer: string) {
        this.require(botId);
        if (this.viewers.has(botId)) throw Error("Desktop already has an active viewer");
        this.viewers.set(botId, viewer);
    }
    hasViewer(botId: string) { return this.viewers.has(botId); }
    releaseViewer(botId: string, viewer: string) {
        if (this.viewers.get(botId) !== viewer) return false;
        this.viewers.delete(botId);
        this.release(botId);
        return true;
    }
    private lease?: {
        botId: string;
        expiresAt: number;
    };
    constructor(readonly capacity = 4, private now = () => Date.now()) {
    }
    bind(botId: string, targetId: string, windowId: number) {
        if (this.bindings.has(botId))
            throw Error('Bot already bound');
        if (this.bindings.size >= this.capacity)
            throw Error('Screen capacity reached');
        if ([...this.bindings.values()].some(b => b.targetId === targetId || b.windowId === windowId))
            throw Error('Window ownership conflict');
        const screen = this.bindings.size;
        const b = {
            botId, targetId, windowId, screen, x: screen * 1280, y: 0, width: 1280, height: 900
        };
        this.bindings.set(botId, b);
        return b;
    }
    require(botId: string, windowId?: number) {
        const b = this.bindings.get(botId);
        if (!b || windowId !== undefined && b.windowId !== windowId)
            throw Error('Window ownership mismatch');
        return b;
    }
    control() {
        if (this.lease && this.lease.expiresAt <= this.now())
            this.lease = undefined;
        return this.lease;
    }
    requireAgent(botId: string) {
        if (this.control())
            throw Error('Human takeover active; desktop actions paused');
        return this.require(botId);
    }
    takeover(botId: string, ms = 60000) {
        this.require(botId);
        const old = this.control();
        if (old && old.botId !== botId)
            throw Error('Another human takeover is active');
        this.lease = {
            botId, expiresAt: this.now() + Math.min(Math.max(ms, 1000), 60000)
        };
        return this.lease;
    }
    release(botId: string) {
        if (this.control()?.botId === botId)
            this.lease = undefined;
    }
}
