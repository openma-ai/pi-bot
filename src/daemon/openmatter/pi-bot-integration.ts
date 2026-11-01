import {
  JsonValueSchema,
  WorkEventSchema,
  type ConversationObservation,
  type JsonValue,
  type WorkEffect,
  type WorkEvent,
} from "@openma/matter";
import {
  IntegrationError,
  type WorkIntegration,
} from "@openma/matter/integration";
import { Effect, Schema } from "effect";
import type { Envelope } from "../../pi/types.ts";
import { redactChannelText } from "../runtime/channel-messages.ts";

/**
 * pi-bot's own chat shell (daemon/GUI/SDK conversations, groups, threads and
 * bot-to-bot) as a simulated IM, described as an OpenMatter integration on
 * par with Slack and Feishu: envelopes are its native events, and
 * `message.reply` is the one conversation write an Agent may call as a tool.
 */
export const PI_BOT_INTEGRATION_ID = "pi-bot";
/** One local workspace: every pi-bot conversation lives under this authority. */
export const PI_BOT_AUTHORITY = "local";
export const PI_BOT_REPLY = "message.reply";
/** The Turn grant for a pi-bot Agent: reply to the triggering message only. */
export const PI_BOT_REPLY_TOOL = `${PI_BOT_INTEGRATION_ID}.${PI_BOT_REPLY}`;

/** Envelope kinds that are input from a host user; every other kind is app traffic. */
const HUMAN_KINDS: readonly Envelope["kind"][] = ["user", "answer"];

export const PI_BOT_EVENT_TYPES = [
  "pi.user",
  "pi.answer",
  "pi.bot",
  "pi.job",
  "pi.schedule",
  "pi.monitor",
  "pi.research",
  "pi.memory",
] as const;

/**
 * The conversation a bot reads. pi-bot conversations are per recipient bot,
 * as in its conversation revision (`conversationResource` + `to`), so two
 * bots in one group keep separate logs and threads.
 */
export const conversationIdFor = (e: Pick<Envelope, "to" | "route">) =>
  JSON.stringify([
    e.to,
    e.route?.channelId ?? "private",
    e.route?.conversationId ?? e.route?.channelId ?? "private",
  ]);
export const threadIdFor = (e: Pick<Envelope, "route">) =>
  e.route?.threadId || "main";
/** The key the OpenMatter kernel uses for a conversation log. */
export const conversationKeyFor = (
  provider: string,
  authority: string,
  conversationId: string,
) => JSON.stringify([provider, authority, conversationId]);

/** A pi-bot envelope as an OpenMatter WorkEvent (the integration's event binding). */
export const workEventForEnvelope = (
  envelope: Envelope,
  activationId = envelope.id,
): WorkEvent => {
  const {
    state,
    admittedAt,
    consumedAt,
    resolvedAt,
    resolution,
    error,
    deferredContinuation,
    ...stable
  } = envelope as Envelope & Record<string, unknown>;
  const stamp = new Date(envelope.createdAt).toISOString();
  return {
    schemaVersion: "1",
    id: activationId,
    type: "pi." + envelope.kind,
    occurredAt: stamp,
    receivedAt: stamp,
    idempotencyKey: activationId,
    source: {
      provider: PI_BOT_INTEGRATION_ID,
      authority: PI_BOT_AUTHORITY,
      conversationId: conversationIdFor(envelope),
      threadId: threadIdFor(envelope),
      messageId: envelope.id,
    },
    payload: JSON.parse(
      JSON.stringify({ ...stable, text: redactChannelText(envelope.text) }),
    ),
  };
};

const payloadOf = (event: WorkEvent): Record<string, unknown> | undefined =>
  typeof event.payload === "object" &&
  event.payload !== null &&
  !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : undefined;

/** Sender of a pi-bot event: host user input is human, bots/jobs/triggers are apps. */
export const observePiBotEvent = (
  event: WorkEvent,
): ConversationObservation | undefined => {
  if (event.source.provider !== PI_BOT_INTEGRATION_ID) return undefined;
  const payload = payloadOf(event);
  const kind = payload?.kind;
  const from = payload?.from;
  if (
    typeof kind !== "string" ||
    typeof from !== "string" ||
    event.source.conversationId === undefined
  )
    return undefined;
  return {
    conversationId: event.source.conversationId,
    kind: "message",
    ...(event.source.threadId === undefined
      ? {}
      : { threadId: event.source.threadId }),
    ...(event.source.messageId === undefined
      ? {}
      : { messageId: event.source.messageId }),
    sender: {
      id: from,
      kind: (HUMAN_KINDS as readonly string[]).includes(kind) ? "human" : "app",
    },
    ...(typeof payload?.text === "string" ? { text: payload.text } : {}),
  };
};

/** What the Agent supplies for `message.reply`; the target is bound by the host. */
export const PiBotReplyToolInputSchema = Schema.Struct({
  text: Schema.String,
  key: Schema.String,
});
/** What is delivered: the Agent's content plus the triggering message it answers. */
export const PiBotReplyInputSchema = Schema.Struct({
  sourceMessageId: Schema.String,
  conversationId: Schema.String,
  threadId: Schema.String,
  text: Schema.String,
  key: Schema.String,
  toolCallId: Schema.optional(Schema.String),
});
export type PiBotReplyInput = typeof PiBotReplyInputSchema.Type;

export const PI_BOT_TOOLS = {
  [PI_BOT_REPLY]: {
    description:
      "Reply to the user in the conversation and thread of the message that triggered this Turn. Not applied, with the newer messages returned, if the user wrote again after what you have seen.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", maxLength: 64000 },
        key: { type: "string", maxLength: 256 },
      },
      required: ["text", "key"],
      additionalProperties: false,
    },
    freshness: "best-effort",
  },
} as const;

/** Host side of a reply: append to pi-bot's outbox/channel_messages like send_message did. */
export interface PiBotReplyPort {
  readonly reply: (input: PiBotReplyInput) => JsonValue;
}

/** A host error whose effect is known not to have been applied (stale task, invalid input). */
export class PiBotReplyNotApplied extends Error {}

export const makePiBotIntegration = (port: PiBotReplyPort): WorkIntegration => ({
  manifest: {
    id: PI_BOT_INTEGRATION_ID,
    displayName: "pi-bot chat",
    events: [...PI_BOT_EVENT_TYPES],
    operations: [PI_BOT_REPLY],
    tools: PI_BOT_TOOLS as unknown as NonNullable<
      WorkIntegration["manifest"]["tools"]
    >,
  },
  ingest: (input) =>
    Effect.suspend(() => {
      const envelope = input as Envelope;
      if (
        typeof envelope?.id !== "string" ||
        typeof envelope.kind !== "string" ||
        typeof envelope.to !== "string" ||
        typeof envelope.text !== "string" ||
        typeof envelope.createdAt !== "number"
      )
        return Effect.fail(
          new IntegrationError({
            message: "Invalid pi-bot envelope",
            retryable: false,
          }),
        );
      const event = workEventForEnvelope(envelope);
      return Schema.is(WorkEventSchema)(event)
        ? Effect.succeed([event])
        : Effect.fail(
            new IntegrationError({
              message: "Invalid pi-bot work event",
              retryable: false,
            }),
          );
    }),
  observe: observePiBotEvent,
  bindToolInput: (operation, input, trigger) => {
    if (operation !== PI_BOT_REPLY)
      return { refused: `Not a pi-bot tool: ${operation}` };
    if (!Schema.is(PiBotReplyToolInputSchema)(input))
      return { refused: "message.reply takes { text, key }" };
    const extra = Object.keys(input as object).filter(
      (k) => k !== "text" && k !== "key",
    );
    if (extra.length > 0)
      return { refused: `message.reply does not accept: ${extra.join(", ")}` };
    const sourceMessageId = payloadOf(trigger)?.id;
    if (
      trigger.source.provider !== PI_BOT_INTEGRATION_ID ||
      typeof sourceMessageId !== "string" ||
      trigger.source.conversationId === undefined
    )
      return { refused: "The Turn was not triggered by a pi-bot message" };
    return {
      input: {
        sourceMessageId,
        conversationId: trigger.source.conversationId,
        threadId: trigger.source.threadId ?? "main",
        text: input.text,
        key: input.key,
      },
    };
  },
  deliver: (effect: WorkEffect) =>
    Effect.suspend(() => {
      if (
        effect.operation !== PI_BOT_REPLY ||
        !Schema.is(PiBotReplyInputSchema)(effect.input)
      )
        return Effect.fail(
          new IntegrationError({
            message: `Unsupported pi-bot effect: ${effect.operation}`,
            retryable: false,
            effectState: "not-applied",
          }),
        );
      const input = effect.input;
      return Effect.try({
        try: () => ({ providerReceipt: port.reply(input) }),
        catch: (cause) =>
          new IntegrationError({
            message: cause instanceof Error ? cause.message : String(cause),
            retryable: false,
            cause,
            ...(cause instanceof PiBotReplyNotApplied
              ? { effectState: "not-applied" as const }
              : {}),
          }),
      }).pipe(
        Effect.filterOrFail(
          (r) => Schema.is(JsonValueSchema)(r.providerReceipt),
          () =>
            new IntegrationError({
              message: "pi-bot receipt is not portable JSON",
              retryable: false,
            }),
        ),
      );
    }),
});
