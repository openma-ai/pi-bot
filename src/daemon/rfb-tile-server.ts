/**
 * Per-session RFB (VNC) endpoint for a macOS virtual-display tile.
 *
 * Linux runs `x11vnc -clip WxH+X+0 -rfbport 5901+screen -localhost -nopw -viewonly`
 * per binding. macOS Screen Sharing is whole-session, and no maintained RFB *server*
 * library exists for Node (libvncserver would need a new native binary + its own
 * Screen Recording grant), so this serves RFB 3.8 directly from frames the
 * already-granted helper captures, cropped to the bot's tile:
 *   - binds 127.0.0.1 only, security type None (same as Linux -localhost -nopw)
 *   - Raw encoding, 32bpp true-colour, shared connections
 *   - view-only by default; `setViewOnly(false)` (human takeover) forwards pointer
 *     clicks / keys through the caller's tile-mapped, serialized input path.
 */
import { createServer, type Server, type Socket } from 'node:net';

export type RgbaFrame = { width: number; height: number; data: Uint8Array };
export type RfbInput = {
    click(x: number, y: number): Promise<unknown>;
    type(text: string): Promise<unknown>;
    key(keys: string[]): Promise<unknown>;
};

const SPECIAL_KEYS: Record<number, string> = {
    0xff0d: 'return', 0xff08: 'delete', 0xff09: 'tab', 0xff1b: 'escape',
    0xff51: 'left', 0xff52: 'up', 0xff53: 'right', 0xff54: 'down', 0xffff: 'forwarddelete',
};

export class RfbTileServer {
    private server?: Server;
    private clients = new Set<Socket>();
    private lastFrame?: RgbaFrame;
    viewOnly = true;

    constructor(
        readonly port: number,
        readonly name: string,
        readonly size: { width: number; height: number },
        private readonly grab: () => Promise<RgbaFrame>,
        private readonly input?: RfbInput,
        readonly host = '127.0.0.1',
    ) {}

    get endpoint() { return `vnc://${this.host}:${this.port}`; }
    get connections() { return this.clients.size; }

    setViewOnly(viewOnly: boolean) { this.viewOnly = viewOnly; }

    listen(): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = createServer(socket => this.accept(socket));
            server.once('error', reject);
            server.listen(this.port, this.host, () => { server.off('error', reject); this.server = server; resolve(); });
        });
    }

    async close() {
        for (const c of this.clients) c.destroy();
        this.clients.clear();
        const s = this.server;
        this.server = undefined;
        if (s) await new Promise<void>(r => s.close(() => r()));
    }

    private accept(socket: Socket) {
        this.clients.add(socket);
        socket.on('close', () => this.clients.delete(socket));
        socket.on('error', () => socket.destroy());
        let buf = Buffer.alloc(0);
        let step: 'version' | 'security' | 'init' | 'normal' = 'version';
        let pending = false;
        let wanted = false;
        const sendUpdate = async () => {
            if (pending) { wanted = true; return; }
            pending = true;
            try {
                do {
                    wanted = false;
                    let frame: RgbaFrame;
                    try { frame = await this.grab(); this.lastFrame = frame; } catch { frame = this.lastFrame ?? this.blank(); }
                    if (socket.destroyed) return;
                    socket.write(encodeRawUpdate(frame, this.size.width, this.size.height));
                } while (wanted && !socket.destroyed);
            } finally { pending = false; }
        };
        socket.write('RFB 003.008\n');
        socket.on('data', chunk => {
            buf = Buffer.concat([buf, chunk]);
            for (;;) {
                if (step === 'version') {
                    if (buf.length < 12) return;
                    buf = buf.subarray(12);
                    socket.write(Buffer.from([1, 1])); // one security type: None
                    step = 'security';
                } else if (step === 'security') {
                    if (buf.length < 1) return;
                    if (buf[0] !== 1) { socket.destroy(); return; }
                    buf = buf.subarray(1);
                    const ok = Buffer.alloc(4); // SecurityResult OK
                    socket.write(ok);
                    step = 'init';
                } else if (step === 'init') {
                    if (buf.length < 1) return;
                    buf = buf.subarray(1); // shared flag: always shared
                    socket.write(serverInit(this.size.width, this.size.height, this.name));
                    step = 'normal';
                } else {
                    if (!buf.length) return;
                    const type = buf[0];
                    const need = type === 0 ? 20 : type === 2 ? (buf.length >= 4 ? 4 + 4 * buf.readUInt16BE(2) : 4) : type === 3 ? 10 : type === 4 ? 8 : type === 5 ? 6 : type === 6 ? (buf.length >= 8 ? 8 + buf.readUInt32BE(4) : 8) : -1;
                    if (need < 0) { socket.destroy(); return; }
                    if (buf.length < need) return;
                    const msg = buf.subarray(0, need);
                    buf = buf.subarray(need);
                    if (type === 3) void sendUpdate();
                    else if (type === 4) this.onKey(msg[1] === 1, msg.readUInt32BE(4));
                    else if (type === 5) this.onPointer(msg[1], msg.readUInt16BE(2), msg.readUInt16BE(4));
                    // SetPixelFormat(0) / SetEncodings(2) / CutText(6): we always send our own format in Raw.
                }
            }
        });
    }

    private lastButtons = 0;
    private onPointer(mask: number, x: number, y: number) {
        const pressed = (mask & 1) && !(this.lastButtons & 1);
        this.lastButtons = mask;
        if (this.viewOnly || !this.input || !pressed) return;
        void this.input.click(x, y).catch(() => undefined);
    }

    private onKey(down: boolean, keysym: number) {
        if (this.viewOnly || !this.input || !down) return;
        const special = SPECIAL_KEYS[keysym];
        if (special) void this.input.key([special]).catch(() => undefined);
        else if (keysym >= 0x20 && keysym <= 0x7e) void this.input.type(String.fromCharCode(keysym)).catch(() => undefined);
    }

    private blank(): RgbaFrame {
        return { width: this.size.width, height: this.size.height, data: new Uint8Array(this.size.width * this.size.height * 4) };
    }
}

function serverInit(width: number, height: number, name: string) {
    const nameBuf = Buffer.from(name, 'utf8');
    const b = Buffer.alloc(24 + nameBuf.length);
    b.writeUInt16BE(width, 0);
    b.writeUInt16BE(height, 2);
    // PIXEL_FORMAT: 32bpp, depth 24, little-endian, true colour, max 255, shifts R16 G8 B0
    b.writeUInt8(32, 4); b.writeUInt8(24, 5); b.writeUInt8(0, 6); b.writeUInt8(1, 7);
    b.writeUInt16BE(255, 8); b.writeUInt16BE(255, 10); b.writeUInt16BE(255, 12);
    b.writeUInt8(16, 14); b.writeUInt8(8, 15); b.writeUInt8(0, 16);
    b.writeUInt32BE(nameBuf.length, 20);
    nameBuf.copy(b, 24);
    return b;
}

/** FramebufferUpdate with one Raw rectangle covering the whole tile (BGRX little-endian). */
export function encodeRawUpdate(frame: RgbaFrame, width: number, height: number) {
    const header = Buffer.alloc(16);
    header.writeUInt8(0, 0);
    header.writeUInt16BE(1, 2);
    header.writeUInt16BE(0, 4); header.writeUInt16BE(0, 6);
    header.writeUInt16BE(width, 8); header.writeUInt16BE(height, 10);
    header.writeInt32BE(0, 12);
    const px = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        if (y >= frame.height) break;
        for (let x = 0; x < width && x < frame.width; x++) {
            const s = (y * frame.width + x) * 4, d = (y * width + x) * 4;
            px[d] = frame.data[s + 2]; px[d + 1] = frame.data[s + 1]; px[d + 2] = frame.data[s]; px[d + 3] = 0;
        }
    }
    return Buffer.concat([header, px]);
}
