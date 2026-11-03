/**
 * Native macOS Computer Use discovery for the host Pi session.
 * Uses community package @nredd/pi-computer-use (official @agent-sh/computer-use-macos 404s).
 * Package is installed by scripts/setup-macos-desktop.sh and is not a hard dependency.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

export const MACOS_COMPUTER_USE_PACKAGE = '@nredd/pi-computer-use';
export const MACOS_COMPUTER_USE_VERSION = '0.6.0';
export const MACOS_HELPER_APP_NAME = 'pi-computer-use.app';
export const MACOS_HELPER_BUNDLE_ID = 'com.injaneity.pi-computer-use';

/** Model-facing tools from @nredd/pi-computer-use when desktop_control is enabled on darwin. */
export const MACOS_COMPUTER_TOOLS = [
    'find_roots', 'observe_ui', 'search_ui', 'expand_ui', 'inspect_ui', 'act_ui',
    'read_text', 'wait_for', 'desktop_screenshot', 'desktop_input',
] as const;

export const MACOS_BROWSER_TOOLS = ['launch_browser', 'navigate_browser', 'evaluate_browser'] as const;

export type MacosComputerUseDiscovery = {
    enabled: boolean;
    packageName: string;
    packageRoot?: string;
    extensionPath?: string;
    helperAppPath?: string;
    helperExecutablePresent: boolean;
    reason: string;
};

function envDisabled(): boolean {
    const v = process.env.PI_BOT_MACOS_COMPUTER_USE;
    return v === '0' || v === 'false' || v === 'off';
}

function envForced(): boolean {
    const v = process.env.PI_BOT_MACOS_COMPUTER_USE;
    return v === '1' || v === 'true' || v === 'on';
}

/** Resolve helper app path without importing the npm package (works when package is absent). */
export function resolveMacosHelperAppPath(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
    const explicit = env.PI_COMPUTER_USE_HELPER_APP_PATH?.trim();
    if (explicit) return isAbsolute(explicit) ? explicit : join(home, explicit);
    const systemPath = join('/Applications', MACOS_HELPER_APP_NAME);
    if (existsSync(systemPath)) return systemPath;
    return join(home, 'Applications', MACOS_HELPER_APP_NAME);
}

export function resolveMacosComputerUsePackageRoot(cwd = process.cwd()): string | undefined {
    try {
        const require = createRequire(join(cwd, 'package.json'));
        return join(require.resolve(`${MACOS_COMPUTER_USE_PACKAGE}/package.json`), '..');
    } catch {
        const local = join(cwd, 'node_modules', MACOS_COMPUTER_USE_PACKAGE);
        return existsSync(join(local, 'package.json')) ? local : undefined;
    }
}

export function discoverMacosComputerUse(options: {
    platform?: string;
    cwd?: string;
    home?: string;
    env?: NodeJS.ProcessEnv;
} = {}): MacosComputerUseDiscovery {
    const platform = options.platform ?? process.platform;
    const cwd = options.cwd ?? process.cwd();
    const env = options.env ?? process.env;
    const packageName = MACOS_COMPUTER_USE_PACKAGE;
    if (platform !== 'darwin') {
        return {
            enabled: false, packageName, helperExecutablePresent: false,
            reason: 'Native macOS Computer Use is only available on darwin hosts',
        };
    }
    if (envDisabled()) {
        return {
            enabled: false, packageName, helperExecutablePresent: false,
            reason: 'Native macOS Computer Use is disabled by PI_BOT_MACOS_COMPUTER_USE',
        };
    }
    const packageRoot = resolveMacosComputerUsePackageRoot(cwd);
    const helperAppPath = resolveMacosHelperAppPath(options.home ?? homedir(), env);
    const helperExecutablePresent = existsSync(join(helperAppPath, 'Contents', 'MacOS', 'bridge'));
    const extensionPath = packageRoot ? join(packageRoot, 'extensions', 'computer-use.ts') : undefined;
    const extensionPresent = !!extensionPath && existsSync(extensionPath);
    if (!packageRoot || !extensionPresent) {
        return {
            enabled: false, packageName, packageRoot, extensionPath, helperAppPath, helperExecutablePresent,
            reason: `Install ${packageName}@${MACOS_COMPUTER_USE_VERSION} with scripts/setup-macos-desktop.sh`,
        };
    }
    if (!helperExecutablePresent && !envForced()) {
        return {
            enabled: false, packageName, packageRoot, extensionPath, helperAppPath, helperExecutablePresent,
            reason: `Helper app missing at ${helperAppPath}; run scripts/setup-macos-desktop.sh and grant Accessibility + Screen Recording`,
        };
    }
    return {
        enabled: true, packageName, packageRoot, extensionPath, helperAppPath, helperExecutablePresent,
        reason: helperExecutablePresent
            ? 'Native macOS Computer Use package and helper app are present'
            : 'Package present; helper app will be installed on first use (PI_BOT_MACOS_COMPUTER_USE forced)',
    };
}

/** Load the community extension factory only when discovery succeeds. */
export async function loadMacosComputerUseExtension(discovery = discoverMacosComputerUse()): Promise<ExtensionFactory | undefined> {
    if (!discovery.enabled || !discovery.extensionPath) return undefined;
    const mod = await import(pathToFileURL(discovery.extensionPath).href);
    const factory = mod.default ?? mod.computerUseExtension;
    if (typeof factory !== 'function') throw Error(`${MACOS_COMPUTER_USE_PACKAGE} extension export is not a function`);
    return factory as ExtensionFactory;
}
