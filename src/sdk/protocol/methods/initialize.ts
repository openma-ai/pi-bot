import { Type } from 'typebox';
import { Id, Time, Json, BotSchema, GroupSchema, ThreadSchema, TurnSchema, ItemSchema, PendingRequestSchema, RoutineSchema, JobSummarySchema, SnapshotSchema, DaemonStatusSchema, RequestKindSchema } from '../models.ts';
import { literals } from '../literals.ts';
import { O, empty, optId, limit, page, ok, filter } from './shared.ts';
export const initializeMethods = {
    'initialize': {
        params: O({
            clientInfo: O({
                name: Id, title: Type.Optional(Type.String()), version: Id
            }), protocolVersion: Id, capabilities: Type.Optional(O({
                experimentalApi: Type.Optional(Type.Boolean()), streamingReplies: Type.Optional(Type.Boolean()), debugInternal: Type.Optional(Type.Boolean()), serverRequests: Type.Optional(Type.Array(RequestKindSchema)), optOutNotifications: Type.Optional(Type.Array(Id))
            }))
        }), result: O({
            serverInfo: O({
                name: Id, version: Id
            }), protocolVersion: Id, capabilities: O({
                transports: Type.Array(Id), requestKinds: Type.Array(RequestKindSchema), experimental: Type.Array(Id)
            }), connectionId: Id, daemon: O({
                status: DaemonStatusSchema, dataDir: Type.String()
            })
        })
    },
} as const;
