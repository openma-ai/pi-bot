import { PiBotError } from "../core/errors.ts";
import { Effect, Schema } from "effect";
import { makeSqliteInbox } from "../../../vendor/openmatter/inbox-sqlite/index.ts";
import {
  WorkEventSchema,
  type WorkEvent,
} from "../../../vendor/openmatter/core/index.ts";
import type { Envelope } from "./store.ts";
import { redactChannelText } from "./channel-messages.ts";
/** Actual OpenMatter durable ingress; lease completion acknowledges Pi handoff only. */
export class OpenMatterTrigger {
  private readonly inbox;
  private activate?: (id: string) => void;
  private busy = false;
  halted = false;
  constructor(filename: string) {
    this.inbox = makeSqliteInbox({
      filename,
    });
  }
  bind(activate: (id: string) => void) {
    this.activate = activate;
  }
  publish(envelope: Envelope, activationId = envelope.id) {
    const {
      state,
      admittedAt,
      consumedAt,
      resolvedAt,
      resolution,
      error,
      deferredContinuation,
      ...stable
    } = envelope;
    const stamp = new Date(envelope.createdAt).toISOString();
    const event: WorkEvent = {
      schemaVersion: "1",
      id: activationId,
      type: "pi." + envelope.kind,
      occurredAt: stamp,
      receivedAt: stamp,
      idempotencyKey: activationId,
      source: {
        provider: "pi-bot",
        authority: envelope.from,
        conversationId:
          envelope.route?.conversationId ??
          envelope.route?.channelId ??
          `local:${envelope.to}`,
        threadId: envelope.route?.threadId ?? "private",
        messageId: envelope.id,
      },
      payload: JSON.parse(
        JSON.stringify({
          ...stable,
          text: redactChannelText(envelope.text),
        }),
      ),
    };
    if (!Schema.is(WorkEventSchema)(event))
      throw new PiBotError("invalidParams", "Invalid OpenMatter work event");
    Effect.runSync(
      this.inbox.enqueue({
        id: event.id,
        idempotencyKey: event.idempotencyKey,
        integrationId: "pi-bot",
        eventType: event.type,
        body: event,
        receivedAt: stamp,
      }),
    );
  }
  flush() {
    if (this.busy || this.halted || !this.activate) return;
    this.busy = true;
    try {
      const claims = Effect.runSync(
        this.inbox.claim({
          ownerId: `pi-host:${process.pid}`,
          durationMs: 30000,
          limit: 32,
        }),
      );
      for (const claim of claims) {
        try {
          const inputId = (
            (claim.item.body as WorkEvent).payload as Record<string, unknown>
          )?.id;
          if (typeof inputId !== "string")
            throw new PiBotError(
              "invalidParams",
              "Missing native inbox correlation",
            );
          this.activate(inputId);
          Effect.runSync(this.inbox.complete(claim.item.id, claim.lease.token));
        } catch {
          this.halted = true;
          Effect.runSync(
            this.inbox.retry(claim.item.id, claim.lease.token, {
              delayMs: 0,
              error: "Pi activation requires host review",
            }),
          );
          break;
        }
      }
    } finally {
      this.busy = false;
    }
  }
  inspect() {
    return Effect.runSync(this.inbox.inspect);
  }
  close() {
    Effect.runSync(this.inbox.close);
  }
}
