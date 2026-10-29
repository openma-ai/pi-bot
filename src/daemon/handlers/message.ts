import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';
import { PiBotError } from '../core/errors.ts';
import { MessageReactionError, reactionUserActor, setMessageReaction } from '../../pi/message-reactions.ts';
export async function messageHandler(d: PiBotDaemon, c: DaemonConnection, method: string, p: any) {
    if (method !== 'message/setReaction') throw new PiBotError('invalidRequest', 'Method not implemented');
    try { return setMessageReaction(d.runtime.store, p, reactionUserActor(c.fileOwner)); }
    catch (error) {
        if (error instanceof MessageReactionError) throw new PiBotError(error.reason, error.message);
        throw error;
    }
}
