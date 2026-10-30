import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import { ModelConnectionError } from './model-connection-error.ts';

export type EndpointModel = { id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number; input: ('text' | 'image')[] };
export type ModelEndpoint = { baseUrl: string; api: 'openai-completions' | 'openai-responses'; models: EndpointModel[] };
export type ModelConnection = { id: string; providerId: string; name: string; revision: number; credentialVersion: number; endpoint?: ModelEndpoint };
export type ModelSelection = { connectionId: string; provider: string; model: string; thinkingLevel: string };
type Document = { version: 1; connections: ModelConnection[]; current?: ModelSelection };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
function invalid(message: string): never { throw new ModelConnectionError('invalidParams', message); }
function text(value: unknown, max = 128): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid('Invalid connection text');
    return value.trim();
}
function fields(value: any, allowed: string[]) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) invalid('Unknown connection field; credentials must use secure login');
}
export function normalizeEndpoint(value: unknown): ModelEndpoint {
    fields(value, ['baseUrl', 'api', 'models']);
    const v = value as any, raw = text(v.baseUrl, 2048);
    if (/[\\?#]/.test(raw) || /%(?:2f|5c|2e)/i.test(raw) || /\/(?:\.{1,2})(?:\/|$)/.test(raw)) invalid('Endpoint must be a plain HTTP(S) base URL without credentials, query or fragment');
    let url: URL;
    try { url = new URL(raw); } catch { invalid('Invalid endpoint URL'); }
    if (url.pathname.includes('//')) invalid('Endpoint path cannot contain duplicate slashes');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) invalid('Invalid endpoint URL');
    if (!['openai-completions', 'openai-responses'].includes(v.api)) invalid('Unsupported SDK endpoint API');
    if (!Array.isArray(v.models) || !v.models.length || v.models.length > 100) invalid('Add between 1 and 100 endpoint models');
    const ids = new Set<string>();
    const models = v.models.map((model: any): EndpointModel => {
        fields(model, ['id', 'name', 'reasoning', 'contextWindow', 'maxTokens', 'input']);
        const id = text(model.id, 256), name = text(model.name ?? id, 256);
        if (ids.has(id)) invalid('Duplicate model ID'); ids.add(id);
        const contextWindow = model.contextWindow ?? 32000, maxTokens = model.maxTokens ?? 4096;
        if (!Number.isSafeInteger(contextWindow) || contextWindow < 256 || contextWindow > 10000000 || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > contextWindow) invalid('Invalid context or output token limits');
        if (model.reasoning !== undefined && typeof model.reasoning !== 'boolean') invalid('Invalid reasoning capability');
        const input = model.input ?? ['text'];
        if (!Array.isArray(input) || !input.length || input.some((p: string) => !['text', 'image'].includes(p)) || new Set(input).size !== input.length || !input.includes('text')) invalid('Invalid model input capabilities');
        return { id, name, reasoning: model.reasoning ?? false, contextWindow, maxTokens, input };
    });
    return { baseUrl: url.href.replace(/\/+$/, ''), api: v.api, models };
}
export function legacyConnectionId(providerId: string) { return 'legacy:' + providerId; }
export function legacyProvider(id: string) { const p = typeof id === 'string' && id.startsWith('legacy:') ? id.slice(7) : ''; return PROVIDER.test(p) ? p : undefined; }

/** Metadata only. Existing Pi credentials remain where they are: no implicit copy or migration. */
export class ModelConnections {
    readonly path: string;
    constructor(readonly agentDir: string) { this.path = join(agentDir, 'model-connections.json'); }
    read(): Document {
        if (!existsSync(this.path)) return { version: 1, connections: [] };
        if (lstatSync(this.path).isSymbolicLink()) throw new Error('Connection metadata symlinks are not supported');
        const source = JSON.parse(readFileSync(this.path, 'utf8'));
        // v0 metadata migration is pure and repeatable; no auth file is ever opened here.
        if (![0, 1].includes(source.version) || !Array.isArray(source.connections)) throw new Error('Unsupported connection metadata version');
        if (source.connections.length > 64) throw new Error('Connection limit exceeded');
        const connections = source.connections.map((c: any) => {
            if (!UUID.test(c.id) || !PROVIDER.test(c.providerId)) throw new Error('Invalid saved connection');
            const endpoint = c.endpoint === undefined ? undefined : normalizeEndpoint(c.endpoint);
            if ((c.providerId === 'custom') !== !!endpoint) throw new Error('Invalid saved endpoint binding');
            const revision = c.revision ?? 1, credentialVersion = c.credentialVersion ?? 1;
            if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(credentialVersion) || credentialVersion < 1) throw new Error('Invalid connection revision');
            return { id: c.id, providerId: c.providerId, name: text(c.name), revision, credentialVersion, ...(endpoint ? { endpoint } : {}) };
        });
        if (new Set(connections.map((c: ModelConnection) => c.id)).size !== connections.length) throw new Error('Duplicate saved connection');
        const current = source.current ?? source.selected;
        if (current && (typeof current.connectionId !== 'string' || (!UUID.test(current.connectionId) && !legacyProvider(current.connectionId)) || !PROVIDER.test(current.provider) || typeof current.model !== 'string' || !current.model || !['off','minimal','low','medium','high','xhigh','max'].includes(current.thinkingLevel))) throw new Error('Invalid saved model connection');
        if (current && legacyProvider(current.connectionId) && legacyProvider(current.connectionId) !== current.provider) throw new Error('Invalid legacy model binding');
        return { version: 1, connections, ...(current ? { current } : {}) };
    }
    private write(document: Document) {
        mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
        const temporary = this.path + '.' + randomUUID() + '.tmp';
        writeFileSync(temporary, JSON.stringify(document, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        renameSync(temporary, this.path);
    }
    get(id: string) { return this.read().connections.find(c => c.id === id); }
    save(input: any): ModelConnection {
        fields(input, ['id', 'providerId', 'name', 'endpoint', 'expectedRevision']);
        const id = input.id ?? randomUUID();
        if (!UUID.test(id) || !PROVIDER.test(input.providerId)) invalid('Invalid connection or provider ID');
        const name = text(input.name), endpoint = input.endpoint === undefined ? undefined : normalizeEndpoint(input.endpoint);
        if ((input.providerId === 'custom') !== !!endpoint) invalid('Custom connections require an endpoint; built-in endpoints cannot be replaced');
        const doc = this.read(), previous = doc.connections.find(c => c.id === id);
        const identity = { providerId: input.providerId, name, ...(endpoint ? { endpoint } : {}) };
        if (previous) {
            const same = JSON.stringify({ providerId: previous.providerId, name: previous.name, ...(previous.endpoint ? { endpoint: previous.endpoint } : {}) }) === JSON.stringify(identity);
            if (same && (input.expectedRevision === undefined || input.expectedRevision === previous.revision || input.expectedRevision === previous.revision - 1)) return previous;
            if (input.expectedRevision !== previous.revision) throw new ModelConnectionError('conflict', 'Connection changed; reload before saving');
            const credentialChanged = previous.providerId !== identity.providerId || JSON.stringify(previous.endpoint) !== JSON.stringify(endpoint);
            const next = { ...identity, id, revision: previous.revision + 1, credentialVersion: previous.credentialVersion + Number(credentialChanged) };
            doc.connections = doc.connections.map(c => c.id === id ? next : c);
            this.write(doc); return next;
        }
        if (input.expectedRevision !== undefined) throw new ModelConnectionError('conflict', 'Connection no longer exists');
        const next = { ...identity, id, revision: 1, credentialVersion: 1 };
        if (doc.connections.length >= 64) throw new ModelConnectionError('capacity', 'Connection limit reached');
        doc.connections.push(next); this.write(doc); return next;
    }
    remove(id: string, expectedRevision: number) {
        const doc = this.read(), previous = doc.connections.find(c => c.id === id);
        if (!previous) throw new ModelConnectionError('notFound', 'Connection not found');
        if (previous.revision !== expectedRevision) throw new ModelConnectionError('conflict', 'Connection changed; reload before removing');
        doc.connections = doc.connections.filter(c => c.id !== id);
        // Retain an unavailable selected identity instead of silently choosing another account.
        this.write(doc);
    }
    select(selection: ModelSelection) { const doc = this.read(); doc.current = selection; this.write(doc); }
    directory(connection: ModelConnection) { return join(this.agentDir, 'connections', connection.id, String(connection.credentialVersion)); }
}

/** A request-time SDK facade bound to exactly one provider and credential directory. */
export async function createConnectionRuntime(store: ModelConnections, connection: ModelConnection): Promise<ModelRuntime> {
    const directory = store.directory(connection);
    for (const path of [join(store.agentDir,'connections'),join(store.agentDir,'connections',connection.id),directory,join(directory,'auth.json')]) {
        if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Connection storage symlinks are not supported');
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const runtime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    if (connection.endpoint) runtime.registerProvider(connection.providerId, {
        name: connection.name, baseUrl: connection.endpoint.baseUrl, api: connection.endpoint.api, authHeader: true,
        models: connection.endpoint.models.map(m => ({ ...m, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }))
    });
    const provider = runtime.getProvider(connection.providerId);
    if (!provider) invalid('Unsupported SDK provider');
    const isolatedContext = { env: async (_name: string) => undefined, fileExists: async (_path: string) => false };
    // Explicit connections never fall back to ambient environment credentials.
    if (provider.auth.apiKey) runtime.registerNativeProvider({ ...provider, auth: { ...provider.auth, apiKey: {
        ...provider.auth.apiKey,
        check: async args => {
            if (!args.credential) return undefined;
            if (provider.auth.apiKey!.check) return provider.auth.apiKey!.check({ ...args, ctx: isolatedContext });
            const resolved = await provider.auth.apiKey!.resolve({ ...args, ctx: isolatedContext });
            return resolved ? { type: 'api_key' as const, source: resolved.source } : undefined;
        },
        resolve: args => args.credential ? provider.auth.apiKey!.resolve({ ...args, ctx: isolatedContext }) : Promise.resolve(undefined)
    } } });
    const matches = (value: string | Model<Api>) => (typeof value === 'string' ? value : value.provider) === connection.providerId;
    const stored = async () => (await runtime.listCredentials()).some(c => c.providerId === connection.providerId);
    return new Proxy(runtime, { get(target, property) {
        if (property === 'getProviders') return () => [target.getProvider(connection.providerId)!];
        if (property === 'getProvider') return (id: string) => matches(id) ? target.getProvider(id) : undefined;
        if (property === 'getModel') return (id: string, model: string) => matches(id) ? target.getModel(id, model) : undefined;
        if (property === 'getModels') return (id?: string) => !id || matches(id) ? target.getModels(connection.providerId) : [];
        if (property === 'getAvailableSnapshot') return () => target.getAvailableSnapshot().filter(m => matches(m));
        if (property === 'listCredentials') return async (options?: any) => (await target.listCredentials(options)).filter(c => matches(c.providerId));
        if (property === 'refresh') return (options: any = {}) => target.refresh({ ...options, providers: [connection.providerId] });
        if (property === 'getAvailable') return async (id?: string, options?: any) => (!id || matches(id)) && await stored() ? target.getAvailable(connection.providerId, options) : [];
        if (property === 'checkAuth') return async (id: string, options?: any) => matches(id) && await stored() ? target.checkAuth(id, options) : undefined;
        if (property === 'getAuth') return async (value: any, options?: any) => matches(value) && await stored() ? target.getAuth(value, options) : undefined;
        const value = Reflect.get(target, property);
        if (['stream','streamSimple','complete','completeSimple','streamDeferred','fetchDeferred','cancelDeferred','generateImages','classify'].includes(String(property))) return (model: Model<Api>, ...args: unknown[]) => {
            const registered = target.getModel(model.provider,model.id);
            if (!matches(model) || !registered || registered.baseUrl !== model.baseUrl || registered.api !== model.api) throw new ModelConnectionError('forbidden', 'Model belongs to a different connection');
            return value.call(target,model,...args);
        };
        return typeof value === 'function' ? value.bind(target) : value;
    } });
}
