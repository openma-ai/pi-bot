import { Type } from 'typebox';
import { TriggerStatusSchema, Id, Time, Json, ThreadSchema, TurnSchema, ItemSchema, PendingRequestSchema, BotSchema, GroupSchema, RoutineSchema, JobSummarySchema, DaemonStatusSchema } from './models.ts';
export const notificationSchemas: Record<string, any> = {
    'daemon/triggerChanged':Type.Object({trigger:TriggerStatusSchema}),
    'daemon/configurationChanged': Type.Object({
        mode: Type.String(), configuration: Json, budget: Type.Optional(Json)
    }),
    'daemon/budgetUpdated': Type.Object({
        budget: Json
    }),
    'daemon/migrated': Type.Object({
        fromVersion: Time, toVersion: Time
    }),
    'group/messageUpdated': Type.Object({
        message: Json
    }),
    'daemon/statusChanged': Type.Object({
        from: DaemonStatusSchema, to: DaemonStatusSchema, at: Time
    }),
    'events/watermark': Type.Object({
        seq: Time
    }),
    'bot/created': Type.Object({
        bot: BotSchema
    }), 'bot/updated': Type.Object({
        bot: BotSchema
    }),
    'group/created': Type.Object({
        group: GroupSchema
    }), 'group/updated': Type.Object({
        group: GroupSchema
    }),
    'turn/queued': Type.Object({
        inputId: Id, threadId: Id, trigger: Id
    }),
    'turn/started': Type.Object({
        turn: TurnSchema
    }), 'turn/completed': Type.Object({
        turn: TurnSchema
    }),
    'item/started': Type.Object({
        item: ItemSchema
    }), 'item/updated': Type.Object({
        item: ItemSchema
    }), 'item/completed': Type.Object({
        item: ItemSchema
    }),
    'request/created': Type.Object({
        request: PendingRequestSchema
    }), 'request/resolved': Type.Object({
        request: PendingRequestSchema
    }),
    'routine/updated': Type.Object({
        routine: RoutineSchema
    }), 'routine/fired': Type.Object({
        routineId: Id, fireId: Id, inputId: Id
    }),
    'job/updated': Type.Object({
        job: JobSummarySchema
    }),
    'task/reviewRequired': Type.Object({
        inputId: Id, threadId: Id, error: Type.Optional(Type.String())
    }),
    'task/reconciled': Type.Object({
        inputId: Id, outcome: Id, evidence: Type.Array(Id)
    }),
    'proposal/updated': Type.Object({
        proposal: Json
    }), 'memory/updated': Type.Object({
        memory: Json
    }),
    'item/agentMessage/delta': Type.Object({
        threadId: Id, turnId: Id, itemId: Id, toolCallId: Id, textDelta: Type.String()
    }),
    'item/toolCall/delta': Type.Object({
        threadId: Id, turnId: Id, itemId: Id, partial: Type.String()
    }),
    'item/internal/delta': Type.Object({
        threadId: Id, turnId: Id, textDelta: Type.String()
    }),
};
for (const method of ['started', 'loaded', 'unloaded', 'archived'])
    notificationSchemas['thread/' + method] = Type.Object({
        thread: ThreadSchema
    });
export const EventEnvelopeSchema = Type.Object({
    seq: Type.Union([Time, Type.Null()]), at: Time, method: Id, params: Json
});
export type EventEnvelope = {
    seq: number | null;
    at: number;
    method: string;
    params: Record<string, any>;
};
