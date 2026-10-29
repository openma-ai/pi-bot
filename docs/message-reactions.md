# Message reactions

`message/setReaction` attaches an emoji to an existing durable chat message; it never creates an outbox message or starts inference.

Parameters: `messageId`, `direction` (`inbound` / `outbound`), `channelId`, `conversationId`, `threadId` (explicit string or `null`), `emoji`, and `present`. `present: true` sets one actor's reaction; `false` removes only that actor's matching emoji. Repeating either operation is a no-op with `changed: false`. Text is never used to identify a target.

The server derives the user actor from the authenticated transport identity, using a stable pseudonym; clients cannot supply an actor. The current workspace authentication model authorizes the host user for workspace messages, not separate per-channel user ACLs. The request's complete scope must still match the stored message. `daemon/snapshot.viewerReactionActorId` lets a client identify its own reactions after reconnect. This represents the transport principal: clients sharing the same service credential share the same reaction identity. It is not a separate multi-user account system.

The `react_to_message` agent tool binds the actor to the bot and inherits the current task's conversation. It checks the source envelope, exact target scope, private bot ownership and current group membership. Internal job/schedule inputs cannot receive chat reactions. A group message's public ID and its per-bot inbox IDs resolve to the same public reaction state. Tool calls are optional acknowledgements, not a requirement to respond to every chat message.

Reactions are additive JSON fields on existing durable envelopes and group messages. Old records read as an empty set; no credential or account migration is involved. Mutations run in one SQLite transaction. Normal runtime state writes preserve current reactions, preventing stale execution snapshots from erasing them. Confirmed updates use existing `item/updated` / `group/messageUpdated` events and snapshots; they do not replay execution failures. One grapheme emoji is accepted, bounded to 32 UTF-16 code units, 12 distinct emoji per actor and 256 total reactions per message.

Validation: `node --import tsx --test test/message-reactions.test.ts test/message-reactions-protocol.test.ts test/protocol-schema.test.ts`. `src/gui/reactions-qa.html` is a standalone synthetic fixture with delayed mock responses for duplicate clicks, cancellation, message switches and errors. It has no runtime connection or credentials. Production renders `MessageReactions` with the actual message, API and snapshot viewer actor.
