import { Value } from 'typebox/value';
import { methods, PROTOCOL_VERSION, REQUEST_KINDS, TRANSPORTS } from '../../sdk/protocol/index.ts';
import { PiBotError } from './errors.ts';
import type { DaemonConnection } from './connection.ts';
import type { PiBotDaemon } from './daemon.ts';
export class Router {
    constructor(readonly daemon: PiBotDaemon) {
    }
    async dispatch(c: DaemonConnection, method: string, params: any) {
        if (method === 'initialize' && c.status !== 'awaitingInit')
            throw new PiBotError('alreadyInitialized', 'Already initialized');
        if (method !== 'initialize' && c.status !== 'active')
            throw new PiBotError('notInitialized', 'Initialize and acknowledge the connection first');
        const def = (methods as any)[method];
        if (!def)
            throw new PiBotError('invalidRequest', 'Method not found', {
                rpcCode: -32601
            });
        const valid: boolean = Value.Check(def.params, params);
        if (!valid)
            throw new PiBotError('invalidParams', 'Invalid method parameters', {
                paths: [...Value.Errors(def.params, params)].map((e: any) => e.instancePath ?? e.path ?? '')
            });
        if (method === 'initialize') {
            if (params.protocolVersion !== PROTOCOL_VERSION)
                throw new PiBotError('invalidRequest', 'Unsupported protocol version', {
                    supported: [PROTOCOL_VERSION]
                });
            c.capabilities = params.capabilities ?? {};
            c.status = 'initializing';
            return {
                serverInfo: {
                    name: 'pi-bot', version: '0.2.0'
                }, protocolVersion: PROTOCOL_VERSION, capabilities: {
                    transports: [...TRANSPORTS], requestKinds: [...REQUEST_KINDS], experimental: []
                }, connectionId: c.id, daemon: {
                    status: this.daemon.status, dataDir: this.daemon.dataDir
                }
            };
        }
        if (this.daemon.status === 'stopped')
            throw new PiBotError('shuttingDown', 'Daemon stopped');
        if (this.daemon.status === 'draining' && ['turn/start', 'turn/steer', 'bot/create', 'group/create', 'routine/create', 'task/reconcile'].includes(method))
            throw new PiBotError('shuttingDown', 'Daemon is draining');
        const result = await this.daemon.handle(c, method, params);
        if (!Value.Check(def.result, result))
            throw new PiBotError('internal', 'Invalid handler result', {
                method, paths: [...Value.Errors(def.result, result)].map((e: any) => e.instancePath ?? e.path ?? '')
            });
        return result;
    }
}
