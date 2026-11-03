/**
 * Credential-free native macOS Computer Use capability probe.
 * Mirrors the Linux doctor shape: never claims ready without a real helper permission check.
 * Does not call registerPermissions / open System Settings / change TCC.
 */
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { boundedProbe, capability, unavailableDesktopCapabilities, type DesktopCapabilities, type DesktopCapability } from '../pi/desktop-capabilities.ts';
import { probeVnc } from './desktop-capabilities.ts';
import {
    discoverMacosComputerUse, MACOS_COMPUTER_TOOLS, MACOS_COMPUTER_USE_PACKAGE,
    resolveMacosHelperAppPath, type MacosComputerUseDiscovery,
} from '../pi/macos-computer-use.ts';
import { resolveMacosVirtualDisplayBinary } from './macos-virtual-display.ts';

const PROBE_TIMEOUT = 2000;
const DEFAULT_SOCKET = () => join(homedir(), 'Library', 'Caches', 'pi-computer-use', 'bridge.sock');

export type MacosPermissionProbe = {
    accessibility: boolean;
    screenRecording: boolean;
    screenRecordingPreflight?: boolean;
};

export type MacosNativeProbeDependencies = {
    platform: string;
    discovery?: MacosComputerUseDiscovery;
    /** Raw helper permission check; inject in tests. Never prompts. */
    checkPermissions?: () => Promise<MacosPermissionProbe>;
    /** Optional connectivity probe when checkPermissions is not supplied. */
    helperReachable?: () => Promise<boolean>;
    /** When false, companion virtual-display binary is missing (inject in tests). */
    virtualDisplayBinaryPresent?: boolean;
    /** Ports of per-bot VNC endpoints (mac-vnc-server) that have been opened (Linux vncPorts analogue). */
    vncPorts?: () => number[];
    vnc?: (port: number) => Promise<DesktopCapability>;
    timeoutMs?: number;
};

export function macosPermissionCapability(status: MacosPermissionProbe) {
    if (status.accessibility === true && status.screenRecording === true) {
        return capability('ready', 'Native macOS helper verified Accessibility and Screen Recording; coordinate and semantic tools depend on the live AX tree');
    }
    if (status.accessibility === false || status.screenRecording === false) {
        const missing = [
            status.accessibility ? undefined : 'Accessibility',
            status.screenRecording ? undefined : 'Screen Recording',
        ].filter(Boolean).join(' and ');
        return capability('permission-required', `Grant ${missing} to pi-computer-use.app in System Settings → Privacy & Security; recheck after toggling`);
    }
    return capability('unknown', 'Native macOS helper returned an unrecognized permission report');
}

/** Talk to the helper unix socket with the same JSON-line protocol the package uses. Read-only. */
export function probeMacosHelperPermissions(socketPath = process.env.PI_CU_SOCKET_PATH ?? DEFAULT_SOCKET(), timeoutMs = 1500): Promise<MacosPermissionProbe> {
    return new Promise((resolve, reject) => {
        const socket = connect(socketPath);
        let buffer = '';
        let done = false;
        const finish = (err?: Error, value?: MacosPermissionProbe) => {
            if (done) return;
            done = true;
            clearTimeout(deadline);
            socket.destroy();
            if (err) reject(err);
            else resolve(value!);
        };
        const deadline = setTimeout(() => finish(Object.assign(new Error('macOS helper permission probe timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
        socket.setEncoding('utf8');
        socket.on('connect', () => {
            const id = `pibo_perm_${Date.now()}`;
            socket.write(`${JSON.stringify({ id, cmd: 'checkPermissions' })}\n`);
        });
        socket.on('data', chunk => {
            buffer += chunk;
            const newline = buffer.indexOf('\n');
            if (newline < 0) return;
            try {
                const parsed = JSON.parse(buffer.slice(0, newline));
                if (parsed.ok !== true) {
                    finish(Object.assign(new Error(parsed?.error?.message ?? 'checkPermissions failed'), { code: parsed?.error?.code ?? 'EPERM' }));
                    return;
                }
                const result = parsed.result ?? {};
                finish(undefined, {
                    accessibility: result.accessibility === true,
                    screenRecording: result.screenRecordingCapturable === true,
                    screenRecordingPreflight: result.screenRecordingPreflight === true,
                });
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        });
        socket.on('error', error => {
            const code = (error as NodeJS.ErrnoException).code;
            finish(Object.assign(error instanceof Error ? error : new Error(String(error)), { code: code ?? 'ECONNREFUSED' }));
        });
        socket.on('end', () => finish(Object.assign(new Error('macOS helper closed before answering'), { code: 'ECONNRESET' })));
    });
}

function probeFailure(error: any, label: string) {
    if (error?.code === 'ENOENT') return capability('unconfigured', `${label} is not installed`);
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return capability('permission-required', `${label} was denied access`);
    if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT' || error?.code === 'ENOTFOUND') {
        return capability('unreachable', `${label} helper socket is not reachable; start the helper or re-run setup`);
    }
    return capability('unreachable', `${label} did not complete its read-only probe within the deadline`);
}

export async function probeMacosNativeCapabilities(deps: MacosNativeProbeDependencies): Promise<DesktopCapabilities> {
    const discovery = deps.discovery ?? discoverMacosComputerUse({ platform: deps.platform });
    const result = unavailableDesktopCapabilities(deps.platform, discovery.enabled || discovery.helperExecutablePresent, 'unconfigured', discovery.reason);
    result.vnc = capability('unconfigured', 'No viewer has been opened; checking capabilities does not start VNC');
    result.browser = capability('unconfigured', 'Browser tools are provided by the native extension when browser_use is enabled in its config');
    result.canOpenView = false;

    if (deps.platform !== 'darwin') {
        result.computerUse = capability('unsupported', 'Native macOS Computer Use requires a darwin host');
        result.screenCapture = capability('unsupported', 'Native macOS screen capture requires a darwin host');
        return result;
    }

    if (!discovery.packageRoot) {
        result.configured = false;
        result.computerUse = capability('unconfigured', discovery.reason);
        result.screenCapture = capability('unconfigured', `Install ${MACOS_COMPUTER_USE_PACKAGE} and its helper before probing Screen Recording`);
        return result;
    }

    result.configured = true;

    if (!discovery.helperExecutablePresent) {
        result.computerUse = capability('unconfigured', discovery.reason);
        result.screenCapture = capability('unconfigured', 'Helper app binary is missing; run scripts/setup-macos-desktop.sh');
        return result;
    }

    const timeout = deps.timeoutMs ?? PROBE_TIMEOUT;
    const check = deps.checkPermissions
        ?? (deps.helperReachable
            ? async () => {
                if (!await deps.helperReachable!()) throw Object.assign(new Error('helper unreachable'), { code: 'ECONNREFUSED' });
                throw Object.assign(new Error('permission probe not wired'), { code: 'ENOTSUP' });
            }
            : () => probeMacosHelperPermissions(undefined, Math.min(1500, timeout)));

    try {
        const status = await boundedProbe(check, timeout);
        result.computerUse = macosPermissionCapability(status);
        result.screenCapture = status.screenRecording === true
            ? capability('ready', 'Helper Screen Recording capture probe succeeded; no image is retained by the harness probe')
            : status.screenRecording === false
                ? capability('permission-required', 'Grant Screen Recording to pi-computer-use.app in System Settings → Privacy & Security')
                : capability('unknown', 'Screen Recording was not verified');
        const vdPresent = deps.virtualDisplayBinaryPresent ?? !!resolveMacosVirtualDisplayBinary();
        // Linux contract: unconfigured until a viewer is opened; then every open per-session
        // RFB endpoint must complete a real handshake for vnc to be ready.
        const ports = deps.vncPorts?.() ?? [];
        if (!vdPresent) result.vnc = capability('unconfigured', 'Build scripts/build-macos-virtual-display.sh to enable per-session VNC endpoints');
        else if (!ports.length) result.vnc = capability('unconfigured', 'No viewer has been opened; checking capabilities does not start VNC');
        else {
            const checks = await Promise.all(ports.map(port => (deps.vnc ?? probeVnc)(port)));
            const bad = checks.find(c => c.state !== 'ready');
            result.vnc = bad ?? capability('ready', `Per-bot VNC endpoints ready on ${ports.map(p => `127.0.0.1:${p}`).join(', ')}`);
        }
        if (result.computerUse.state === 'ready') {
            result.availableTools.computer = [...MACOS_COMPUTER_TOOLS];
            // Browser tools stay gated on extension config; do not advertise until a live browser probe exists.
            result.availableTools.browser = [];
            result.browser = capability('unknown', 'Native browser tools ship with the extension; readiness is not claimed without a CDP probe');
            // Mirror Linux canOpenView: window/input/capture ready + a viewer path exists.
            result.canOpenView = result.screenCapture.state === 'ready' && vdPresent;
            if (!vdPresent) {
                // Tools still work on the shared desktop; isolation/view require the companion binary.
                result.canOpenView = false;
            }
        }
    } catch (error: any) {
        // Helper present but daemon not running yet: still configured, not ready.
        if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT' || error?.code === 'ETIMEDOUT' || error?.code === 'ECONNRESET') {
            result.computerUse = capability('unreachable', 'Native macOS helper app is installed but did not answer the read-only permission probe');
            result.screenCapture = capability('unreachable', 'Screen Recording could not be probed because the helper did not answer');
        } else {
            result.computerUse = probeFailure(error, 'Native macOS Computer Use');
            result.screenCapture = probeFailure(error, 'Native macOS screen capture');
        }
    }
    return result;
}

/** Cheap filesystem-only snapshot used before the first async probe completes. */
export function unconfiguredMacosNativeCapabilities(platform = process.platform, cwd = process.cwd()): DesktopCapabilities {
    if (platform !== 'darwin') return unavailableDesktopCapabilities(platform);
    const discovery = discoverMacosComputerUse({ platform, cwd });
    const result = unavailableDesktopCapabilities(platform, !!discovery.packageRoot || discovery.helperExecutablePresent, 'unconfigured', discovery.reason);
    result.computerUse = discovery.packageRoot
        ? (discovery.helperExecutablePresent
            ? capability('unknown', 'Native macOS helper is present; waiting for a read-only permission probe')
            : capability('unconfigured', discovery.reason))
        : capability('unconfigured', discovery.reason);
    result.screenCapture = capability('unknown', 'macOS Screen Recording and Accessibility permissions have not been probed');
    result.vnc = capability('unconfigured', 'No viewer has been opened; checking capabilities does not start VNC');
    return result;
}

export function macosHelperLooksInstalled(home = homedir(), env: NodeJS.ProcessEnv = process.env): boolean {
    const app = resolveMacosHelperAppPath(home, env);
    return existsSync(join(app, 'Contents', 'MacOS', 'bridge'));
}
