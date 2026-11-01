import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_FRESHNESS,
  JsonValueSchema,
  type ConversationEntry,
  type ConversationMessage,
  type FreshnessPolicy,
  type JsonValue,
  type OperationCall,
  type OperationCallResult,
  type WorkEffect,
  type WorkEvent,
} from "@openma/matter";
import type { WorkIntegration } from "@openma/matter/integration";
import { Effect, Exit, Schema } from "effect";
import { conversationKeyFor } from "./pi-bot-integration.ts";

/**
 * The OpenMatter operation-call path for pi-bot, run in-process on pi-bot's
 * SQLite store: the conversation log (one entry per observed event, revisions
 * from 1), one OperationCall record per Turn and call id, the grant, the
 * host-bound input, the freshness check against what the Turn has seen, and
 * delivery through the integration with a receipt.
 *
 * It follows `callOperation` in @openma/matter's agent-turn runtime
 * (docs/TURN_TOOLS.md) step for step. That function is not exported by
 * @openma/matter 0.2.7; when it is, this class should delegate to it with an
 * OpenMatterStore over these tables.
 */
export class OpenMatterReplyHost {
  constructor(
    private readonly db: DatabaseSync,
    private readonly integrations: ReadonlyMap<string, WorkIntegration>,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS om_conversation_entries(conversation_key TEXT NOT NULL, revision INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, PRIMARY KEY(conversation_key, revision)); CREATE TABLE IF NOT EXISTS om_operation_calls(turn_id TEXT NOT NULL, call_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(turn_id, call_id));",
    );
  }

  private tx<A>(f: () => A): A {
    if (this.db.isTransaction) return f();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = f();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Records an accepted event in its conversation log; idempotent by event id. */
  record(event: WorkEvent): ConversationEntry | undefined {
    const integration = this.integrations.get(event.source.provider);
    const observation = integration?.observe?.(event);
    if (!observation) return undefined;
    return this.tx(() => {
      const existing = this.entry(event.id);
      if (existing) return existing;
      const key = conversationKeyFor(
        event.source.provider,
        event.source.authority,
        observation.conversationId,
      );
      const last = this.db
        .prepare(
          "SELECT max(revision) AS r FROM om_conversation_entries WHERE conversation_key=?",
        )
        .get(key) as { r: number | null };
      const entry: ConversationEntry = {
        conversationKey: key,
        revision: (last.r ?? 0) + 1,
        eventId: event.id,
        kind: observation.kind,
        occurredAt: event.occurredAt,
        ...(observation.threadId === undefined
          ? {}
          : { threadId: observation.threadId }),
        ...(observation.messageId === undefined
          ? {}
          : { messageId: observation.messageId }),
        ...(observation.sender === undefined
          ? {}
          : { sender: observation.sender }),
        ...(observation.text === undefined ? {} : { text: observation.text }),
      };
      this.db
        .prepare(
          "INSERT INTO om_conversation_entries(conversation_key, revision, event_id, data) VALUES(?,?,?,?)",
        )
        .run(key, entry.revision, entry.eventId, JSON.stringify(entry));
      return entry;
    });
  }

  entry(eventId: string): ConversationEntry | undefined {
    const row = this.db
      .prepare("SELECT data FROM om_conversation_entries WHERE event_id=?")
      .get(eventId) as { data: string } | undefined;
    return row && JSON.parse(row.data);
  }

  entriesAfter(key: string, revision: number): ConversationEntry[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM om_conversation_entries WHERE conversation_key=? AND revision>? ORDER BY revision",
        )
        .all(key, revision) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }

  getCall(turnId: string, callId: string): OperationCall | undefined {
    const row = this.db
      .prepare("SELECT data FROM om_operation_calls WHERE turn_id=? AND call_id=?")
      .get(turnId, callId) as { data: string } | undefined;
    return row && JSON.parse(row.data);
  }

  private putCall(call: OperationCall) {
    this.db
      .prepare(
        "INSERT INTO om_operation_calls(turn_id, call_id, data) VALUES(?,?,?) ON CONFLICT(turn_id, call_id) DO UPDATE SET data=excluded.data",
      )
      .run(call.turnId, call.callId, JSON.stringify(call));
  }

  private complete(call: OperationCall, result: OperationCallResult) {
    const done: OperationCall = {
      ...call,
      state: "completed",
      result,
      completedAt: this.clock(),
    };
    this.putCall(done);
    return result;
  }

  /**
   * One operation call by an Agent during its Turn. `seen.revision` is what
   * the Turn has been shown of the trigger's conversation; a conflict result
   * advances it, as in the kernel.
   */
  call(input: {
    readonly turnId: string;
    readonly callId: string;
    readonly trigger: WorkEvent;
    readonly allow: readonly string[];
    readonly freshness?: FreshnessPolicy;
    readonly seen: { revision: number };
    readonly params: {
      readonly integrationId: string;
      readonly operation: string;
      readonly input: JsonValue;
    };
  }): OperationCallResult | { status: "fingerprint-mismatch" } {
    const result = this.callOnce(input);
    if (result.status === "conflict")
      input.seen.revision = Math.max(input.seen.revision, result.seenRevision);
    return result;
  }

  private callOnce(
    input: Parameters<OpenMatterReplyHost["call"]>[0],
  ): OperationCallResult | { status: "fingerprint-mismatch" } {
    const { turnId, callId } = input;
    const freshness = input.freshness ?? DEFAULT_FRESHNESS;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([input.trigger.id, input.params]))
      .digest("hex");
    const stored = this.getCall(turnId, callId);
    if (stored && stored.fingerprint !== fingerprint)
      return { status: "fingerprint-mismatch" };
    if (stored?.state === "completed" && stored.result) return stored.result;
    if (stored?.state === "pending")
      return this.tx(() =>
        this.complete(stored, {
          status: "uncertain",
          reason:
            "The outcome of this call was not recorded before the Turn was interrupted; check before calling again",
        }),
      );

    const { integrationId, operation } = input.params;
    const name = `${integrationId}.${operation}`;
    const integration = this.integrations.get(integrationId);
    const declared =
      integration !== undefined &&
      (integration.manifest.operations.includes("*") ||
        integration.manifest.operations.includes(operation));
    const unbound = !Schema.is(JsonValueSchema)(input.params.input)
      ? "Operation call input must be JSON"
      : !input.allow.includes(name)
        ? `Operation is not allowed for this Turn: ${name}`
        : !declared
          ? `Unknown operation: ${name}`
          : undefined;
    let binding: { input: JsonValue } | { refused: string } | undefined;
    if (
      unbound === undefined &&
      integration?.bindToolInput &&
      integration.manifest.tools?.[operation]
    ) {
      try {
        binding = integration.bindToolInput(
          operation,
          input.params.input,
          input.trigger,
        );
        if ("input" in binding && !Schema.is(JsonValueSchema)(binding.input))
          binding = { refused: "The integration bound a non-JSON input" };
      } catch {
        binding = { refused: "The integration could not bind the call's input" };
      }
    }
    const refusal =
      unbound ?? (binding && "refused" in binding ? binding.refused : undefined);
    const deliveredInput =
      binding && "input" in binding ? binding.input : input.params.input;
    const call: OperationCall = {
      turnId,
      callId,
      fingerprint,
      integrationId,
      operation,
      input: deliveredInput,
      state: "pending",
      startedAt: this.clock(),
    };
    const guarded =
      refusal === undefined &&
      integration?.manifest.tools?.[operation]?.freshness !== undefined;

    // Check and record are one SQLite transaction: no entry can be appended
    // between reading the log and inserting the call.
    const decision = this.tx(() => {
      const trigger = guarded ? this.entry(input.trigger.id) : undefined;
      if (refusal !== undefined || !integration) {
        this.putCall(call);
        return this.complete(call, {
          status: "refused",
          reason: refusal ?? `Unknown operation: ${name}`,
        });
      }
      if (trigger) {
        const after = Math.max(trigger.revision, input.seen.revision);
        const entries = this.entriesAfter(trigger.conversationKey, after);
        const revision = entries.at(-1)?.revision ?? after;
        const newer = entries.filter((e) => counts(e, trigger, freshness));
        if (newer.length > 0) {
          this.putCall(call);
          return this.complete(call, {
            status: "conflict",
            effect: "not-applied",
            conflict: { reason: "newer_messages", messages: newer.map(asMessage) },
            seenRevision: revision,
          });
        }
        this.putCall({
          ...call,
          conversation: { key: trigger.conversationKey, revision },
        });
        return undefined;
      }
      this.putCall(call);
      return undefined;
    });
    if (decision) return decision;

    const effectId = `${turnId}:call:${callId}`;
    const effect: WorkEffect = {
      schemaVersion: "0.1",
      id: effectId,
      eventId: input.trigger.id,
      integrationId,
      operation,
      idempotencyKey: effectId,
      input: deliveredInput,
    };
    const exit = Effect.runSyncExit(integration!.deliver(effect));
    const result: OperationCallResult = Exit.isSuccess(exit)
      ? {
          status: "delivered",
          ...(exit.value.providerReceipt === undefined
            ? {}
            : { receipt: exit.value.providerReceipt }),
        }
      : (() => {
          const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
          if (failure?.effectState === "not-applied")
            return {
              status: "failed" as const,
              reason: failure.message,
              retryable: failure.retryable,
            };
          return {
            status: "uncertain" as const,
            reason: failure?.message ?? "The integration failed while delivering the call",
          };
        })();
    return this.tx(() => this.complete(this.getCall(turnId, callId)!, result));
  }
}

/** Whether a newer entry makes a write to the trigger's conversation stale (kernel `counts`). */
const counts = (
  entry: ConversationEntry,
  trigger: ConversationEntry,
  policy: FreshnessPolicy,
): boolean => {
  if (entry.eventId === trigger.eventId) return false;
  if (!policy.kinds.includes(entry.kind)) return false;
  if (
    policy.scope === "thread" &&
    (entry.threadId === undefined || entry.threadId !== trigger.threadId)
  )
    return false;
  const sender = entry.sender;
  const senders = policy.senders;
  if (senders === "anyone") return true;
  if (sender === undefined) return false;
  if (senders === "humans") return sender.kind === "human";
  if (senders === "requester") return sender.id === trigger.sender?.id;
  return senders.ids.includes(sender.id);
};

const asMessage = (entry: ConversationEntry): ConversationMessage => ({
  kind: entry.kind,
  occurredAt: entry.occurredAt,
  ...(entry.threadId === undefined ? {} : { threadId: entry.threadId }),
  ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }),
  ...(entry.sender === undefined ? {} : { sender: entry.sender }),
  ...(entry.text === undefined ? {} : { text: entry.text }),
});
