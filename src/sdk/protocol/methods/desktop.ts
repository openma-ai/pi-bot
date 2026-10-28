import { Type } from 'typebox';
import { Id, Time, Json, DesktopCapabilitiesSchema } from '../models.ts';
import { literals } from '../literals.ts';
import { O, empty, optId, limit, page, ok, filter } from './shared.ts';
export const desktopMethods = {
    'desktop/capabilities': { params: O({ botId: Type.Optional(Id), refresh: Type.Optional(Type.Boolean()) }), result: DesktopCapabilitiesSchema },
    'desktop/bind': {
        params: O({
            botId: Id
        }), result: Json
    },
    'desktop/control': {
        params: O({
            botId: Id, take: Type.Boolean()
        }), result: Type.Union([O({
                botId: Id, expiresAt: Time
            }), Type.Null()])
    },
} as const;
