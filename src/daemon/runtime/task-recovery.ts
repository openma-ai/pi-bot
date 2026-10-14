import type { Store } from "./store.ts";
import type { Envelope, Outbound, Job } from "../../pi/types.ts";
import type { Item, Turn } from "../../sdk/protocol/models.ts";
const imageGuard =
  "ContextBudgetError: Image inputs need a provider-specific context budget. No input or history was truncated.";
/** Proven screenshot-only checkpoints can resume; unknown effects are never replayed. */
export function recoveryPlan(s: Store, e: Envelope) {
  const out = s.list<Outbound>("outbox").filter((o) => o.taskId === e.taskId);
  if (
    out.some(
      (o) => o.replyTo === e.id && o.botId === e.to && o.state === "delivered",
    )
  )
    return { canRetry: true, reason: "delivered" };
  if (
    e.state !== "uncertain" ||
    e.resolvedAt ||
    out.length ||
    s.list<Job>("jobs").some((j) => j.taskId === e.taskId)
  )
    return { canRetry: false, reason: "effectsUnknown" };
  const turns = s
    .list<Turn>("turns")
    .filter((t) => t.taskId === e.taskId && t.botId === e.to);
  const tools = s
    .list<Item>("items")
    .filter(
      (i) => i.type === "toolCall" && turns.some((t) => t.id === i.turnId),
    );
  const readOnly = (i: Item) => {
    const p = i.args as any;
    return (
      i.status === "completed" &&
      (i.tool === "desktop_list" ||
        (i.tool === "desktop_call" &&
          p &&
          ((p.kind === "computer" &&
            ["screenshot", "get_app_state", "list_windows"].includes(p.tool)) ||
            (p.kind === "browser" &&
              p.tool === "screenshot" &&
              (!p.args?.action || p.args.action === "screenshot")))))
    );
  };
  if (
    !e.consumedAt &&
    e.error === "Error: Provider request refused or failed before streaming" &&
    tools.every(readOnly)
  )
    return { canRetry: true, reason: "prestream" };
  if (e.error !== imageGuard)
    return { canRetry: false, reason: "effectsUnknown" };
  return tools.length > 0 && tools.every(readOnly)
    ? { canRetry: true, reason: "imageContext" }
    : { canRetry: false, reason: "effectsUnknown" };
}
