import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { WebSocketServer } from 'ws';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { DesktopOwnership } from './desktop-ownership.ts';
const option = (name: string) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? undefined : process.argv[i + 1];
};
const root = resolve(option('--root') ?? '/data');
const port = Number(option('--port') ?? 8080);
const controlUrl = option('--url') ?? 'http://127.0.0.1:6090';
mkdirSync(root, {
    recursive: true
});
const tokenFile = join(root, 'control.json');
const token = existsSync(tokenFile) ? JSON.parse(readFileSync(tokenFile, 'utf8')).token : randomBytes(32).toString('hex');
writeFileSync(tokenFile, JSON.stringify({
    url: controlUrl, token, sameRuntime: process.argv.includes('--same-runtime')
}), {
    mode: 0o600
});
const owners = new DesktopOwnership(4);
const cdpModule = await import('../../node_modules/pi-chrome-use/src/cdp/session.ts');
const storeModule = await import('../../node_modules/pi-chrome-use/src/session-store.ts');
const browserModule = await import('../../node_modules/pi-chrome-use/extensions/browser-execute.ts');
const computerPath = join(process.cwd(), 'node_modules/@agent-sh/computer-use-linux/pi/extension/index.ts');
const admin = new cdpModule.Session();
let ready = false;
for (let i = 0; i < 100; i++) {
    try {
        await admin.connect({
            wsUrl: (await (await fetch('http://127.0.0.1:9222/json/version')).json() as any).webSocketDebuggerUrl
        });
        ready = true;
        break;
    }
    catch {
        await new Promise(r => setTimeout(r, 100));
    }
}
if (!ready)
    throw Error('Chromium CDP did not start');
let currentBot = '';
let vncController: string | undefined;
const models = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false
});
const faux = fauxProvider();
models.registerNativeProvider(faux.provider);
const routedBrowser: ExtensionFactory = pi => browserModule.default(new Proxy(pi, {
    get(target, prop) {
        if (prop === 'registerTool')
            return (def: any) => pi.registerTool({
                ...def, execute(id: any, p: any, s: any, u: any, ctx: any) {
                    return def.execute(id, p, s, u, {
                        ...ctx, cwd: join(root, 'botspaces', currentBot), sessionId: currentBot
                    });
                }
            });
        return Reflect.get(target, prop);
    }
}));
const dispatcher: ExtensionFactory = pi => pi.registerTool({
    name: 'desktop_dispatch', label: 'Desktop dispatcher', description: 'Host-only plugin dispatcher', parameters: Type.Object({
        tool: Type.String(), args: Type.Record(Type.String(), Type.Unknown())
    }), async execute(_id, p, _s, _u, ctx) {
        const outcome = await ctx.executeTool(p.tool, p.args);
        return {
            ...outcome.result, isError: outcome.isError
        };
    }
});
const settings = SettingsManager.inMemory({
    compaction: {
        enabled: false
    }, retry: {
        enabled: false
    }
});
const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, additionalExtensionPaths: [computerPath], extensionFactories: [routedBrowser, dispatcher]
});
await loader.reload();
const { session } = await createAgentSession({
    cwd: root, agentDir: root, modelRuntime: models, model: faux.getModel(), settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.create(root, root), noTools: 'builtin'
});
await session.bindExtensions({
    mode: 'print', onError: e => console.error('Desktop extension initialization failed', e.event)
});
const allowedComputer = ['doctor', 'list_windows', 'activate_window', 'get_app_state', 'screenshot', 'click', 'drag', 'press_key', 'scroll', 'type_text', 'set_value', 'perform_action'];
async function dispatch(tool: string, args: Record<string, unknown>) {
    faux.setResponses([fauxAssistantMessage(fauxToolCall('desktop_dispatch', {
            tool, args: JSON.parse(JSON.stringify(args))
        }), {
            stopReason: 'toolUse'
        }), fauxAssistantMessage('Host dispatch completed')]);
    await session.prompt('Execute the host-authorized desktop tool request.');
    const result = session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'desktop_dispatch').at(-1);
    if (!result || result.role !== 'toolResult')
        throw Error('Plugin dispatch did not produce a result');
    return {
        content: result.content, details: result.details, isError: result.isError || result.content.some(c => {
            if (c.type !== "text")
                return false;
            try {
                return JSON.parse(c.text).ok === false;
            }
            catch {
                return false;
            }
        })
    };
}
await dispatch('computer_use_linux_tools', {
    tools: allowedComputer
});
async function focusOwned(windowId: number) {
    const result: any = await dispatch('computer_use_linux_activate_window', {
        window_id: windowId
    });
    if (result.isError || Number(execFileSync('xdotool', ['getactivewindow'], {
        encoding: 'utf8'
    }).trim()) !== windowId)
        throw Error('Owned window could not be focused');
}
let tail: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>) => {
    const next = tail.then(fn);
    tail = next.catch(() => {
    });
    return next;
};
async function confine(b: ReturnType<DesktopOwnership['require']>) {
    const w = await admin._call('Browser.getWindowForTarget', {
        targetId: b.targetId
    }) as any;
    const q = w.bounds;
    if (q.windowState !== 'normal')
        await admin._call('Browser.setWindowBounds', {
            windowId: w.windowId, bounds: {
                windowState: 'normal'
            }
        });
    if (q.left !== b.x || q.top !== b.y || q.width !== b.width || q.height !== b.height || q.windowState !== 'normal')
        await admin._call('Browser.setWindowBounds', {
            windowId: w.windowId, bounds: {
                left: b.x, top: b.y, width: b.width, height: b.height
            }
        });
}
async function binding(botId: string) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(botId))
        throw Error('Invalid bot ID');
    if (owners.bindings.has(botId)) {
        const b = owners.require(botId);
        await admin._call('Target.getTargetInfo', {
            targetId: b.targetId
        });
        await confine(b);
        execFileSync('xdotool', ['getwindowgeometry', String(b.windowId)]);
        return b;
    }
    if (owners.bindings.size >= 4)
        throw Error('Screen capacity reached');
    const { targetId } = await admin._call('Target.createTarget', {
        url: `http://127.0.0.1:${port}/fixture?bot=${botId}`, newWindow: true, background: true
    }) as any;
    const { windowId } = await admin._call('Browser.getWindowForTarget', {
        targetId
    }) as any;
    const screen = owners.bindings.size;
    await admin._call('Browser.setWindowBounds', {
        windowId, bounds: {
            windowState: 'normal', left: screen * 1280, top: 0, width: 1280, height: 900
        }
    });
    let xid = 0;
    for (let i = 0; i < 100; i++) {
        try {
            xid = Number(execFileSync('xdotool', ['search', '--onlyvisible', '--name', `PiBot:${botId}`], {
                encoding: 'utf8'
            }).trim().split('\n')[0]);
            if (xid)
                break;
        }
        catch {
        }
        await new Promise(r => setTimeout(r, 100));
    }
    if (!xid)
        throw Error('Browser X11 window not found');
    const b = owners.bind(botId, targetId, xid);
    const p = 5901 + screen;
    writeFileSync(join(root, `vnc-${screen}.cmd`), '', {
        mode: 0o600
    });
    spawn('x11vnc', ['-display', ':99', '-clip', `1280x900+${b.x}+0`, '-rfbport', String(p), '-localhost', '-nopw', '-forever', '-shared', '-viewonly', '-connect', join(root, `vnc-${screen}.cmd`)], {
        stdio: 'ignore'
    });
    const s = storeModule.SessionStore.get(botId);
    await s.connect({
        wsUrl: (await (await fetch('http://127.0.0.1:9222/json/version')).json() as any).webSocketDebuggerUrl
    });
    await s.use(targetId);
    await s._call('Page.navigate', {
        url: 'about:blank'
    });
    const call = s._call.bind(s);
    s._call = async (method: string, params: any = {}) => {
        owners.require(botId);
        if (method === 'Target.getTargets') {
            const all = await call(method, params) as any;
            return {
                ...all, targetInfos: all.targetInfos.filter((t: any) => t.targetId === targetId)
            };
        }
        if (method.startsWith('Target.') && params.targetId !== targetId)
            throw Error('Foreign target rejected');
        if (method.startsWith('Browser.') || method === 'Target.createTarget')
            throw Error('Browser-wide operation rejected');
        return call(method, params);
    };
    s.use = async (id: string) => {
        if (id !== targetId)
            throw Error('Foreign target rejected');
        return s.getActiveSession()!;
    };
    s.connect = async () => {
    };
    writeFileSync(join(root, 'bindings.json'), JSON.stringify([...owners.bindings.values()], null, 2));
    return b;
}
const api = createServer(async (req, res) => {
    try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/fixture') {
            const id = (url.searchParams.get('bot') ?? 'fixture').replace(/[^a-zA-Z0-9_-]/g, '');
            res.setHeader('content-type', 'text/html');
            res.end(`<title>PiBot:${id}</title><body style="font:30px sans-serif;background:${id.endsWith('b') ? '#ddeeff' : '#ffeecc'}"><h1>${id}</h1><label>Value <input id="value" aria-label="Value"></label><button onclick="document.querySelector('#result').textContent=document.querySelector('#value').value">Apply</button><p id="result"></p></body>`);
            return;
        }
        if (req.headers.authorization !== `Bearer ${token}`) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }
        const json = (v: unknown) => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(v));
        };
        if (url.pathname === '/tools') {
            json({
                browser: {
                    actions: ['navigate', 'evaluate', 'screenshot'], engine: 'pi-chrome-use@1.1.1'
                }, computer: allowedComputer.map(name => ({
                    name, parameters: session.getToolDefinition('computer_use_linux_' + name)?.parameters
                }))
            });
            return;
        }
        if (url.pathname === '/state') {
            json({
                bindings: [...owners.bindings.values()], control: owners.control()
            });
            return;
        }
        let data: any = {};
        if (req.method === 'POST') {
            let body = '';
            for await (const c of req) {
                body += c;
                if (body.length > 200000)
                    throw Error('Request too large');
            }
            data = JSON.parse(body);
        }
        if (url.pathname === '/bind') {
            json(await serial(() => binding(data.botId)));
            return;
        }
        if (url.pathname.startsWith('/screen/')) {
            const botId = url.pathname.slice(8), b = await binding(botId);
            for (const item of owners.bindings.values())
                await confine(item);
            const png = execFileSync('import', ['-display', ':99', '-window', 'root', '-crop', `${b.width}x${b.height}+${b.x}+0`, 'png:-'], {
                maxBuffer: 8 * 1024 * 1024, timeout: 10000
            });
            res.setHeader('content-type', 'image/png');
            res.setHeader('cache-control', 'no-store');
            res.end(png);
            return;
        }
        if (url.pathname === '/control') {
            const result = await serial(async () => {
                const b = owners.require(data.botId);
                if (data.take) {
                    if (!owners.hasViewer(data.botId)) throw Error("Open the desktop before taking control");
                    owners.takeover(data.botId);
                    await focusOwned(b.windowId);
                    execFileSync('x11vnc', ['-display', ':99', '-connect', join(root, `vnc-${b.screen}.cmd`), '-sync', '-R', 'noviewonly']);
                    vncController = data.botId;
                }
                else {
                    execFileSync('x11vnc', ['-display', ':99', '-connect', join(root, `vnc-${b.screen}.cmd`), '-sync', '-R', 'viewonly']);
                    owners.release(data.botId);
                    if (vncController === data.botId)
                        vncController = undefined;
                }
                return owners.control() ?? null;
            });
            json(result);
            return;
        }
        if (url.pathname === '/call') {
            json(await serial(async () => {
                const b = owners.requireAgent(data.botId);
                await binding(data.botId);
                if (data.windowId !== undefined)
                    owners.require(data.botId, data.windowId);
                currentBot = data.botId;
                if (data.kind === 'browser') {
                    const p = data.args ?? {};
                    let code;
                    if (p.action === 'navigate')
                        code = `await session.Page.enable();const loaded=session.waitFor('Page.loadEventFired',undefined,5000);await session.Page.navigate({url:${JSON.stringify(p.url)}});await loaded;`;
                    else if (p.action === 'evaluate')
                        code = `return await session.Runtime.evaluate({expression:${JSON.stringify(p.expression)},returnByValue:true});`;
                    else if (p.action === 'screenshot')
                        code = 'return await session.Page.captureScreenshot({format:"png"});';
                    else
                        throw Error('Unknown browser action');
                    return dispatch('browser_execute', {
                        code, description: 'Operate owned browser window', timeout: 10000
                    });
                }
                if (!allowedComputer.includes(data.tool))
                    throw Error('Unknown computer tool');
                const args = {
                    ...(data.args ?? {})
                };
                for (const key of ['pid', 'app_id', 'wm_class', 'title', 'window_title', 'app_name_or_bundle_identifier', 'terminal_command', 'terminal_cwd', 'terminal_pid', 'tty'])
                    if (args[key] !== undefined)
                        throw Error('Ambiguous target selector rejected');
                if (args.window_id !== undefined)
                    owners.require(data.botId, args.window_id);
                if (data.tool === 'list_windows')
                    return {
                        binding: b, content: [{
                                type: 'text', text: JSON.stringify({
                                    windows: [{
                                            window_id: b.windowId, botId: b.botId, screen: b.screen
                                        }]
                                })
                            }], details: {
                            binding: b
                        }
                    };
                if (data.tool === 'doctor')
                    return dispatch('computer_use_linux_doctor', args);
                if (data.tool === 'screenshot' && args.full_screen === true)
                    throw Error('Whole desktop capture rejected');
                if (data.tool === 'click' || data.tool === 'scroll') {
                    if (args.x !== undefined || args.y !== undefined) {
                        if (!Number.isInteger(args.x) || !Number.isInteger(args.y) || args.x < 0 || args.x >= b.width || args.y < 0 || args.y >= b.height)
                            throw Error('Coordinates outside owned screen');
                        args.relative = true;
                    }
                }
                if (data.tool === 'drag') {
                    for (const key of ['start_x', 'end_x']) {
                        if (!Number.isInteger(args[key]) || args[key] < 0 || args[key] >= b.width)
                            throw Error('Coordinates outside owned screen');
                        args[key] += b.x;
                    }
                    for (const key of ['start_y', 'end_y']) {
                        if (!Number.isInteger(args[key]) || args[key] < 0 || args[key] >= b.height)
                            throw Error('Coordinates outside owned screen');
                        args[key] += b.y;
                    }
                }
                await focusOwned(b.windowId);
                const schema: any = session.getToolDefinition(`computer_use_linux_${data.tool}`)?.parameters;
                if (schema?.properties?.window_id)
                    args.window_id = b.windowId;
                return dispatch(`computer_use_linux_${data.tool}`, args);
            }));
            return;
        }
        res.writeHead(404);
        res.end();
    }
    catch {
        res.writeHead(409);
        res.end(JSON.stringify({
            error: 'Desktop operation rejected; check ownership, window state or takeover'
        }));
    }
});
const ws = new WebSocketServer({
    noServer: true
});
api.on('upgrade', (req, socket, head) => {
    let claimed: { id: string; viewer: string } | undefined;
    try {
        if (req.headers.authorization !== `Bearer ${token}`)
            throw Error();
        const id = new URL(req.url ?? '/', 'http://localhost').pathname.slice('/ws/'.length);
        const b = owners.require(id);
        const viewer = randomUUID();
        owners.claimViewer(id, viewer);
        claimed = { id, viewer };
        // A new socket must never inherit an interrupted client's write mode.
        execFileSync('x11vnc', ['-display', ':99', '-connect', join(root, `vnc-${b.screen}.cmd`), '-sync', '-R', 'viewonly']);
        ws.handleUpgrade(req, socket, head, web => {
            const tcp = connect(5901 + b.screen, '127.0.0.1');
            web.on('message', data => {
                void serial(async () => {
                    if (vncController === id && owners.control()?.botId !== id) {
                        execFileSync('x11vnc', ['-display', ':99', '-connect', join(root, `vnc-${b.screen}.cmd`), '-sync', '-R', 'viewonly']);
                        vncController = undefined;
                    }
                    if (owners.control()?.botId === id && Number(execFileSync('xdotool', ['getactivewindow'], {
                        encoding: 'utf8'
                    }).trim()) !== b.windowId)
                        await focusOwned(b.windowId);
                    tcp.write(Buffer.from(data as any));
                }).catch(() => web.close());
            });
            web.on('error', () => web.close());
            tcp.on('data', d => web.readyState === 1 && web.send(d));
            web.on('close', () => {
                tcp.destroy();
                void serial(async () => {
                    if (!owners.releaseViewer(id, viewer)) return;
                    execFileSync('x11vnc', ['-display', ':99', '-connect', join(root, `vnc-${b.screen}.cmd`), '-sync', '-R', 'viewonly']);
                    if (vncController === id) vncController = undefined;
                }).catch(() => {});
            });
            tcp.on('close', () => web.close());
            tcp.on('error', () => web.close());
        });
    }
    catch {
        if (claimed) owners.releaseViewer(claimed.id, claimed.viewer);
        socket.destroy();
    }
});
setInterval(() => {
    void serial(async () => {
        for (const b of owners.bindings.values())
            try {
                await confine(b);
            }
            catch {
            }
        if (vncController && owners.control()?.botId !== vncController) {
            const b = owners.require(vncController);
            execFileSync('x11vnc', ['-display', ':99', '-connect', join(root, `vnc-${b.screen}.cmd`), '-sync', '-R', 'viewonly']);
            vncController = undefined;
        }
    }).catch(() => {
    });
}, 1000).unref();
api.listen(port, option('--bind') ?? '0.0.0.0', () => console.log('Desktop ready; Pi browser/computer plugins loaded'));
