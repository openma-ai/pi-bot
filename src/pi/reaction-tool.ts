import { Type } from 'typebox';
import type { BotHost } from './host.ts';
import type { Envelope } from './types.ts';
import { setAgentMessageReaction } from './message-reactions.ts';

export function registerReactionTool(pi: { registerTool(tool: any): void }, options: {
    runtime: BotHost; own(source?: string, mutation?: boolean): Envelope; result(value: unknown): any;
}) {
    pi.registerTool({
        name: 'react_to_message', label: 'React to a message',
        description: 'Attach or remove one emoji on an existing chat message in the inherited conversation. Use the exact stable message_id and direction, never message text. Actor is this bot. present=true sets, false removes; repeating the same state is safe. A reaction can acknowledge casual chatter without sending a separate text reply. Do not react to every message automatically.',
        parameters: Type.Object({message_id:Type.String({minLength:1,maxLength:512}),direction:Type.Union([Type.Literal('inbound'),Type.Literal('outbound')]),emoji:Type.String({minLength:1,maxLength:32}),present:Type.Boolean(),source_message_id:Type.Optional(Type.String())}),
        async execute(_id: string, p: {message_id:string;direction:'inbound'|'outbound';emoji:string;present:boolean;source_message_id?:string}) {
            const source=options.own(p.source_message_id,true);
            options.runtime.assertTaskCurrent(source);
            return options.result(setAgentMessageReaction(options.runtime.store,source,{messageId:p.message_id,direction:p.direction,emoji:p.emoji,present:p.present}));
        }
    });
}
