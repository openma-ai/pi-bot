import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { Value } from 'typebox/value';
import { RuntimeProfileSchema, type RuntimeProfile as AnyRuntimeProfile, type RuntimeStatus } from '../../sdk/protocol/client-runtime.ts';
import { ensureServer, type ServerEndpoint } from './server-start.ts';
type RuntimeProfile=Exclude<AnyRuntimeProfile,{mode:"tailnet"}>;
export function validateProfile(value: unknown): RuntimeProfile {
    if (!Value.Check(RuntimeProfileSchema, value))
        throw Error('请检查连接配置：主机、目录和端口');
    if ((value as AnyRuntimeProfile).mode === "tailnet") throw Error("应用内 Tailscale 仅支持原生 Apple 客户端");
    const profile = value as RuntimeProfile;
    if (profile.mode === 'ssh' && profile.embeddedTailscale)
        throw Error('应用内 Tailscale 仅支持原生 Apple 客户端');
    if (profile.mode === 'ssh' && !profile.projectDir.startsWith('/') && !profile.projectDir.startsWith('~/'))
        throw Error('SSH 项目目录请填写绝对路径或 ~/ 开头的路径');
    return profile.mode === 'local' ? {
        ...profile, dataDir: resolve(profile.dataDir)
    } : {
        ...profile, node: profile.node ?? 'node'
    };
}
const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const sshOptions = (p: Extract<RuntimeProfile, {
    mode: 'ssh';
}>) => ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', ...(p.sshPort ? ['-p', String(p.sshPort)] : []), ...(p.configFile ? ['-F', p.configFile] : [])];
export function sshStartArgs(value: unknown) {
    const p = validateProfile(value);
    if (p.mode !== 'ssh')
        throw Error('SSH profile required');
    const directory = p.projectDir.startsWith('~/') ? '"$HOME"/' + quote(p.projectDir.slice(2)) : quote(p.projectDir);
    const args = ['--import', 'tsx', 'src/daemon/main.ts', 'ensure', '--data-dir', p.dataDir, '--listen', 'http://127.0.0.1:' + p.serverPort].map(quote).join(' ');
    const runner = p.node === 'node' ? 'if [ -x "$HOME/.local/share/pi-bot/node/bin/node" ]; then "$HOME/.local/share/pi-bot/node/bin/node" ' + args + '; else node ' + args + '; fi' : quote(p.node!) + ' ' + args;
    const command = 'cd ' + directory + ' && ' + runner;
    return [...sshOptions(p), p.host, command];
}
function connectionError(error: unknown, mode: string) {
    const text = String(error);
    if (/host key verification|REMOTE HOST IDENTIFICATION|known_hosts/i.test(text))
        return Error('SSH 主机尚未信任或指纹已变化。请先在本机终端验证并连接该主机。');
    if (/permission denied|publickey/i.test(text))
        return Error('SSH 认证失败。请检查本机 SSH 配置或已解锁的密钥。');
    if (/ENOENT|command not found|cannot find package/i.test(text))
        return Error(mode === 'ssh' ? 'SSH 服务器缺少 Node.js 或 Pi Bot。请检查项目目录和 Node 路径。' : '本机 server 无法启动，请检查 Pi Bot 安装。');
    return Error(mode === 'ssh' ? 'SSH server 未连接，请检查主机、端口和远程 Pi Bot 安装。' : '本机 server 未连接，请检查端口和安装。');
}
async function capture(args: string[]) {
    return new Promise<string>((done, reject) => {
        const child = spawn('ssh', args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '', stderr = '', overflow = false;
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(Error('SSH timeout'));
        }, 30000);
        child.stdout.on('data', b => {
            stdout += b;
            if (stdout.length > 65536) {
                overflow = true;
                child.kill('SIGKILL');
            }
        });
        child.stderr.on('data', b => {
            stderr = (stderr + b).slice(-8192);
        });
        child.on('error', e => {
            clearTimeout(timer);
            reject(e);
        });
        child.on('exit', code => {
            clearTimeout(timer);
            code === 0 && !overflow ? done(stdout) : reject(Error(stderr));
        });
    });
}
async function freePort() {
    const s = createServer();
    await new Promise<void>((done, reject) => {
        s.once('error', reject);
        s.listen(0, '127.0.0.1', done);
    });
    const port = (s.address() as {
        port: number;
    }).port;
    await new Promise<void>(done => s.close(() => done()));
    return port;
}
async function openSsh(p: Extract<RuntimeProfile, {
    mode: 'ssh';
}>): Promise<ServerEndpoint> {
    const output = await capture(sshStartArgs(p));
    const line = output.split('\n').find(l => l.startsWith('PI_BOT_SERVER='));
    if (!line)
        throw Error('SSH server discovery unavailable');
    const endpoint = JSON.parse(line.slice(14));
    const remote = new URL(endpoint.url);
    if (remote.protocol !== 'http:' || remote.hostname !== '127.0.0.1' || !/^[a-f0-9]{64}$/.test(endpoint.token))
        throw Error('Invalid SSH server discovery');
    const port = await freePort();
    const child = spawn('ssh', [...sshOptions(p), '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${port}:127.0.0.1:${remote.port}`, p.host], {
        stdio: ['ignore', 'ignore', 'pipe']
    });
    let failure = '', exited = false;
    child.stderr!.on('data', b => {
        failure = (failure + b).slice(-8192);
    });
    child.on('error', e => {
        failure = String(e);
        exited = true;
    });
    child.on('exit', () => {
        exited = true;
    });
    const url = 'http://127.0.0.1:' + port, until = Date.now() + 12000;
    while (!exited && Date.now() < until) {
        try {
            // Node fetch rewrites Host to the forwarded local port. The remote daemon
            // deliberately validates its own loopback host/port, so use http.request.
            const ready = await new Promise<boolean>(done => {
                const req = httpRequest(url + '/readyz', {
                    headers: {
                        host: remote.host
                    }
                }, res => {
                    res.resume();
                    done(res.statusCode === 200);
                });
                req.setTimeout(1000, () => {
                    req.destroy();
                    done(false);
                });
                req.on('error', () => done(false));
                req.end();
            });
            if (ready)
                return {
                    url, host: remote.host, token: endpoint.token, close: () => stop(child)
                };
        }
        catch {
        }
        await new Promise(r => setTimeout(r, 100));
    }
    stop(child);
    throw Error(failure || 'SSH tunnel timeout');
}
function stop(child: ChildProcess) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
        if (child.exitCode === null)
            child.kill('SIGKILL');
    }, 2000);
    timer.unref();
}
type NamedProfile = RuntimeProfile & {
    id: string;
    name: string;
};
const connectionKey = (p: RuntimeProfile) => JSON.stringify(p.mode === 'local'
    ? {
        mode: p.mode, dataDir: p.dataDir, agentDir: p.agentDir
    }
    : {
        mode: p.mode, host: p.host, projectDir: p.projectDir, dataDir: p.dataDir, sshPort: p.sshPort, configFile: p.configFile, node: p.node, serverPort: p.serverPort
    });
export class RuntimeManager {
    private profiles: NamedProfile[];
    private active: RuntimeStatus['active'] = null;
    private endpoint?: ServerEndpoint;
    private connecting = false;
    private selectedId = 'local';
    private closed = false;
    private retired = new Set<() => void>();
    constructor(private options: {
        file: string;
        defaults: {
            local: RuntimeProfile;
            ssh: RuntimeProfile | null;
        } | RuntimeProfile[];
        projectDir?: string;
        open?: (p: RuntimeProfile) => Promise<ServerEndpoint>;
    }) {
        const defaults = Array.isArray(options.defaults) ? options.defaults : [{
                ...options.defaults.local, id: 'local', name: '本机'
            }, ...(options.defaults.ssh ? [{
                    ...options.defaults.ssh, id: 'cloud'
                }] : [])];
        let stored: any;
        if (existsSync(options.file))
            stored = JSON.parse(readFileSync(options.file, 'utf8'));
        const raw = Array.isArray(stored?.profiles) ? stored.profiles : stored?.profiles ? [{
                ...stored.profiles.local, id: 'local', name: '本机'
            }, ...(stored.profiles.ssh ? [{
                    ...stored.profiles.ssh, id: 'cloud'
                }] : [])] : defaults;
        this.profiles = raw.map((p: RuntimeProfile) => this.named(validateProfile(p)));
        if (!this.profiles.length || this.profiles.length > 32 || new Set(this.profiles.map(p => p.id)).size !== this.profiles.length)
            throw Error('Invalid runtime profiles');
        this.selectedId = stored?.selectedId ?? (stored?.selectedMode === 'ssh' ? 'cloud' : this.profiles[0].id);
    }
    private named(p: RuntimeProfile, old?: NamedProfile): NamedProfile {
        const id = p.id ?? old?.id ?? 'rt_' + randomUUID().replaceAll('-', '');
        const profile = {
            ...p, id, name: p.name?.trim() || old?.name || (p.mode === 'local' ? '本机' : p.host)
        };
        if (profile.mode === 'local' && id !== 'local' && !profile.agentDir)
            profile.agentDir = join(profile.dataDir, 'pi');
        return profile;
    }
    private prepare(value: unknown) {
        const p = validateProfile(value), old = this.profiles.find(existing => p.id ? existing.id === p.id : connectionKey(existing) === connectionKey(p));
        const next = this.named(p, old);
        if (this.profiles.some(existing => existing.id !== next.id && connectionKey(existing) === connectionKey(next)))
            throw Error('此连接已经添加，请编辑已有 runtime');
        if (!old && this.profiles.length >= 32)
            throw Error('Runtime 数量已达上限');
        return next;
    }
    status(): RuntimeStatus {
        return structuredClone({
            profiles: this.profiles, active: this.active, connecting: this.connecting
        });
    }
    initialProfile() {
        return this.profiles.find(p => p.id === this.selectedId) ?? this.profiles[0];
    }
    private persist(profiles = this.profiles, selectedId = this.selectedId) {
        mkdirSync(dirname(this.options.file), {
            recursive: true
        });
        const temp = this.options.file + '.' + randomUUID();
        writeFileSync(temp, JSON.stringify({
            profiles, selectedId
        }), {
            mode: 0o600
        });
        renameSync(temp, this.options.file);
    }
    private upsert(p: NamedProfile) {
        return this.profiles.some(old => old.id === p.id) ? this.profiles.map(old => old.id === p.id ? p : old) : [...this.profiles, p];
    }
    configure(value: unknown) {
        if (this.connecting)
            throw Error('正在启用 runtime，请等待完成');
        const p = this.prepare(value), next = this.upsert(p);
        this.persist(next);
        this.profiles = next;
        if (this.active?.profileId === p.id && this.active.profile && connectionKey(validateProfile(this.active.profile)) === connectionKey(p)) {
            this.active.profile = p;
            this.active.label = p.name;
        }
        return this.status();
    }
    remove(id: string) {
        if (this.connecting || this.active?.profileId === id)
            throw Error('请先启用其他 runtime，再移除这个连接');
        const next = this.profiles.filter(p => p.id !== id);
        if (next.length === this.profiles.length)
            throw Error('Runtime 已不存在');
        if (!next.length)
            throw Error('至少保留一个 runtime');
        const selectedId = next.some(p => p.id === this.selectedId) ? this.selectedId : next[0].id;
        this.persist(next, selectedId);
        this.profiles = next;
        this.selectedId = selectedId;
        return this.status();
    }
    async connect(value: unknown) {
        if (this.closed || this.connecting)
            throw Error('已有连接操作正在进行');
        const p = this.prepare(value), scope = createHash('sha256').update(connectionKey(p)).digest('hex').slice(0, 24);
        this.connecting = true;
        try {
            const endpoint = await (this.options.open ? this.options.open(p) : p.mode === 'local' ? ensureServer({
                dataDir: p.dataDir, agentDir: p.agentDir, projectDir: this.options.projectDir ?? process.cwd(), port: 0
            }) : openSsh(p));
            if (this.closed) {
                endpoint.close();
                throw Error('Client closed');
            }
            try {
                const next = this.upsert(p);
                this.persist(next, p.id);
                this.profiles = next;
                this.selectedId = p.id;
            }
            catch (e) {
                endpoint.close();
                throw e;
            }
            this.retire();
            const id = randomUUID();
            this.endpoint = endpoint;
            this.active = {
                id, profileId: p.id, mode: p.mode, profile: p, baseUrl: '/runtime/' + id, scope, label: p.name
            };
            return this.status();
        }
        catch (e) {
            throw connectionError(e, p.mode);
        }
        finally {
            this.connecting = false;
        }
    }
    route(id: string) {
        if (!this.endpoint || this.active?.id !== id)
            throw Error('连接已切换，请重新连接');
        return this.endpoint;
    }
    onRetire(fn: () => void) {
        this.retired.add(fn);
        return () => this.retired.delete(fn);
    }
    private retire() {
        for (const fn of this.retired)
            fn();
        this.endpoint?.close();
        this.endpoint = undefined;
        this.active = null;
    }
    disconnect() {
        if (this.connecting)
            throw Error('正在连接，请等待完成');
        this.retire();
        return this.status();
    }
    async close() {
        this.closed = true;
        this.retire();
    }
}
