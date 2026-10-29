import { Type } from 'typebox';
import { Id, Time } from '../models.ts';
import { O } from './shared.ts';
export const messageMethods = {
    'message/setReaction': {
        params: O({ messageId: Id, direction: Type.Union([Type.Literal('inbound'), Type.Literal('outbound')]), channelId: Id, conversationId: Id, threadId: Type.Union([Id, Type.Null()]), emoji: Type.String({minLength:1,maxLength:32}), present: Type.Boolean() }),
        result: O({ changed: Type.Boolean(), actorId: Id, reactions: Type.Array(O({actorId: Id, emoji: Type.String({minLength:1,maxLength:32}), createdAt: Time})) })
    }
} as const;
