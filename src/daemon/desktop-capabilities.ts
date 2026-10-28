import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { join, isAbsolute } from 'node:path';
import { boundedProbe, capability, unavailableDesktopCapabilities, type DesktopCapabilities, type DesktopCapability } from '../pi/desktop-capabilities.ts';

const PROBE_TIMEOUT = 2000;
const COMPUTER_TOOLS = ['doctor', 'list_windows', 'activate_window', 'click', 'drag', 'press_key', 'scroll', 'type_text'];
export type DesktopProbeDependencies = {
    platform: string;
    doctor: () => Promise<unknown>;
    cdp: () => Promise<unknown>;
    capture: () => Promise<boolean>;
    input: () => Promise<boolean>;
    viewer: () => Promise<boolean>;
    vncPorts: () => number[];
    vnc?: (port: number) => Promise<DesktopCapability>;
    timeoutMs?: number;
};

/** Parse only known upstream readiness booleans; diagnostics may contain private paths. */
export function computerDoctorCapability(value: any): DesktopCapability {
    const ready = value?.readiness;
    if (!ready || typeof ready !== 'object') return capability('unknown', 'Computer Use doctor returned no recognized readiness report');
    const needed = ['can_query_windows', 'can_focus_windows', 'can_send_development_input'];
    if (needed.every(key => ready[key] === true)) return capability('ready', ready.can_build_accessibility_tree === true
        ? 'Computer Use doctor verified window targeting, accessibility and input backends; screen capture is checked separately'
        : 'Computer Use window targeting and coordinate input are ready; accessibility selectors and semantic tools are unavailable');
    // Only explicit failed checks can establish a permission blocker. Never infer
    // granted permissions from a configured endpoint or an installed executable.
    const checks = [value?.accessibility?.at_spi_bus, value?.input?.uinput, value?.input?.ydotool_socket, value?.platform?.x11_display];
    if (checks.some(check => check?.ok === false && /permission denied|access denied|not authorized|permission required/i.test(String(check.detail))))
        return capability('permission-required', 'Computer Use doctor reported denied desktop access; permission changes require the user');
    if (needed.some(key => typeof ready[key] !== 'boolean')) return capability('unknown', 'Computer Use doctor did not verify all required operation capabilities');
    if (!ready.can_send_development_input) return capability('unconfigured', 'Computer Use has no ready input backend');
    return capability('unreachable', 'Computer Use cannot currently query and focus owned windows');
}

export async function probeDesktopCapabilities(deps: DesktopProbeDependencies): Promise<DesktopCapabilities> {
    const result = unavailableDesktopCapabilities(deps.platform, true, 'unknown', 'Capability probe has not completed');
    if (deps.platform !== 'linux') {
        result.computerUse = capability('unsupported', 'The configured desktop service supports Linux X11 only');
        result.screenCapture = capability('unknown', 'Native screen-capture and accessibility permissions have not been probed');
        result.browser = capability('unsupported', 'The owned-window desktop adapter supports Linux X11 only');
        result.vnc = capability('unconfigured', 'No supported desktop viewer is configured');
        return result;
    }
    const timeout = deps.timeoutMs ?? PROBE_TIMEOUT;
    const checked = await Promise.allSettled([
        boundedProbe(deps.doctor, timeout), boundedProbe(deps.cdp, timeout), boundedProbe(deps.capture, timeout), boundedProbe(deps.viewer, timeout), boundedProbe(deps.input, timeout),
        ...deps.vncPorts().map(port => boundedProbe(() => (deps.vnc ?? probeVnc)(port), timeout))
    ]);
    const [doctor, cdp, capture, viewer, input, ...vnc] = checked;
    result.computerUse = doctor.status === 'fulfilled' ? computerDoctorCapability(doctor.value) : probeFailure(doctor.reason, 'Computer Use doctor');
    if (result.computerUse.state === 'ready' && (input.status !== 'fulfilled' || input.value !== true)) result.computerUse = input.status === 'rejected'
        ? probeFailure(input.reason, 'X11 input backend') : capability('unreachable', 'X11 input backend did not answer the read-only pointer and XTEST checks');
    result.browser = cdp.status === 'fulfilled' && typeof (cdp.value as any)?.product === 'string'
        ? capability('ready', 'Chromium answered the CDP Browser.getVersion command')
        : cdp.status === 'rejected' ? probeFailure(cdp.reason, 'Chromium CDP') : capability('unknown', 'Chromium returned an unrecognized CDP response');
    result.screenCapture = capture.status === 'fulfilled' && capture.value === true
        ? capability('ready', 'A read-only one-pixel X11 capture succeeded; no image is retained')
        : capture.status === 'rejected' ? probeFailure(capture.reason, 'X11 screen capture') : capability('unknown', 'X11 screen capture could not be verified');
    result.vnc = !vnc.length ? capability('unconfigured', 'No viewer has been opened; checking capabilities does not start VNC')
        : vnc.map(p => p.status === 'fulfilled' ? p.value as DesktopCapability : probeFailure(p.reason, 'VNC')).find(c => c.state !== 'ready')
          ?? capability('ready', 'Existing VNC servers completed a shared, view-only RFB handshake');
    const windowReady = doctor.status === 'fulfilled' && (doctor.value as any)?.readiness?.can_query_windows === true && (doctor.value as any)?.readiness?.can_focus_windows === true;
    result.canOpenView = windowReady && input.status === 'fulfilled' && input.value === true && result.browser.state === 'ready' && result.screenCapture.state === 'ready' && viewer.status === 'fulfilled' && viewer.value === true;
    if (!vnc.length && (viewer.status === 'rejected' || !viewer.value)) result.vnc = capability('unconfigured', 'The VNC viewer executable is not available');
    result.availableTools.browser = result.browser.state === 'ready' ? ['navigate', 'evaluate', 'screenshot'] : [];
    result.availableTools.computer = result.computerUse.state === 'ready' ? [...COMPUTER_TOOLS] : [];
    const accessibility = doctor.status === 'fulfilled' && (doctor.value as any)?.readiness?.can_build_accessibility_tree === true;
    if (result.computerUse.state === 'ready' && accessibility) result.availableTools.computer.push('set_value', 'perform_action');
    if (result.computerUse.state === 'ready' && result.screenCapture.state === 'ready') {
        result.availableTools.computer.push('screenshot');
        if (accessibility) result.availableTools.computer.push('get_app_state');
    }
    return result;
}

function probeFailure(error: any, label: string): DesktopCapability {
    if (error?.code === 'ENOENT') return capability('unconfigured', `${label} executable is not installed`);
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return capability('permission-required', `${label} was denied access`);
    return capability('unreachable', `${label} did not complete its read-only probe within the deadline`);
}

/** Only the desktop service's existing environment is passed to diagnostics. */
function desktopEnvironment() {
    const keys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'XDG_SESSION_DESKTOP', 'GTK_MODULES', 'NO_AT_BRIDGE'];
    return Object.fromEntries(keys.flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
}
function command(file: string, args: string[], binary = false): Promise<string | Buffer> {
    return new Promise((resolve, reject) => execFile(file, args, { env: desktopEnvironment(), timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, encoding: binary ? 'buffer' : 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
export function linuxDoctor(cwd = process.cwd()) {
    const override = process.env.COMPUTER_USE_LINUX_BIN;
    const binary = override && isAbsolute(override) ? override : join(cwd, 'node_modules/@agent-sh/computer-use-linux/npm/bin', `computer-use-linux-${process.platform}-${process.arch}`);
    if (!existsSync(binary)) return Promise.reject(Object.assign(new Error('Computer Use binary is not installed'), { code: 'ENOENT' }));
    return command(binary, ['doctor']).then(output => JSON.parse(String(output)));
}
export async function probeX11Capture() {
    // This adapter owns DISPLAY=:99. Never capture the macOS/Windows host or
    // trigger a portal/permission prompt; do not focus a window or save pixels.
    const data = await command('import', ['-display', ':99', '-window', 'root', '-crop', '1x1+0+0', '-depth', '8', 'rgb:-'], true);
    return data.length === 3;
}
export async function probeViewerExecutable() {
    await command('x11vnc', ['-version']);
    return true; // Some builds print their version on stderr.
}
export async function probeX11Input() {
    // Query only: no focus, synthetic keys, pointer movement or permission prompts.
    const [pointer, extensions] = await Promise.all([command('xdotool', ['getmouselocation', '--shell']), command('xdpyinfo', ['-display', ':99', '-queryExtensions'])]);
    return /^X=\d+/m.test(String(pointer)) && /^Y=\d+/m.test(String(pointer)) && /\bXTEST\b/.test(String(extensions));
}

/** RFB 3.8 None auth handshake; no keyboard/pointer events and no lease. */
export async function probeVnc(port: number, timeoutMs = 1500): Promise<DesktopCapability> {
    return new Promise(resolve => {
        const socket = connect({ host: '127.0.0.1', port });
        let buffer = Buffer.alloc(0), step = 0, securityTypes = 0, done = false;
        const finish = (state: DesktopCapability['state'], reason: string) => {
            if (done) return;
            done = true; clearTimeout(deadline); socket.destroy(); resolve(capability(state, reason));
        };
        const deadline = setTimeout(() => finish('unreachable', 'VNC handshake timed out'), timeoutMs);
        socket.on('error', () => finish('unreachable', 'The existing VNC viewer is unreachable'));
        socket.on('end', () => finish('unreachable', 'VNC closed before the handshake completed'));
        socket.on('data', data => {
            buffer = Buffer.concat([buffer, data]);
            if (buffer.length > 65536) return finish('unknown', 'VNC returned an oversized handshake');
            while (!done) {
                if (step === 0) {
                    if (buffer.length < 12) return;
                    const version = buffer.subarray(0, 12).toString('ascii'); buffer = buffer.subarray(12);
                    if (version !== 'RFB 003.008\n') return finish('unknown', 'VNC protocol version is not supported by the read-only probe');
                    socket.write(version); step = 1;
                } else if (step === 1) {
                    if (!buffer.length) return;
                    securityTypes = buffer[0]; buffer = buffer.subarray(1); step = 2;
                    if (!securityTypes) return finish('permission-required', 'VNC refused the view-only handshake');
                } else if (step === 2) {
                    if (buffer.length < securityTypes) return;
                    if (!buffer.subarray(0, securityTypes).includes(1)) return finish('permission-required', 'VNC requires authentication not configured for this adapter');
                    buffer = buffer.subarray(securityTypes); socket.write(Buffer.from([1])); step = 3;
                } else if (step === 3) {
                    if (buffer.length < 4) return;
                    if (buffer.readUInt32BE(0) !== 0) return finish('permission-required', 'VNC rejected the view-only handshake');
                    buffer = buffer.subarray(4); socket.write(Buffer.from([1])); step = 4; // shared ClientInit
                } else {
                    if (buffer.length < 24) return;
                    if (!buffer.readUInt16BE(0) || !buffer.readUInt16BE(2)) return finish('unknown', 'VNC did not expose a framebuffer');
                    return finish('ready', 'The existing VNC server completed a shared, view-only RFB handshake');
                }
            }
        });
    });
}
