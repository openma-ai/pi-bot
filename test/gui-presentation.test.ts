import test from "node:test";
import assert from "node:assert/strict";
import {
  botActivity,
  messageSegments,
  avatarVariant,
  conversationList,
} from "../src/gui/presentation.ts";

test("bots and groups share a recent-conversation list with scope-safe previews", () => {
  const data: any = {
    bots: [
      { id: "a", name: "Alice", createdAt: 1 },
      { id: "b", name: "Bob", createdAt: 2 },
    ],
    groups: [
      { id: "g", name: "Build team", memberIds: ["a", "b"], createdAt: 3 },
    ],
    messages: [
      {
        botId: "a",
        channelId: "local:a",
        direction: "outbound",
        status: "delivered",
        text: "private result",
        receivedAt: 10,
      },
      {
        botId: "a",
        channelId: "g",
        sourceKind: "user",
        text: "shared input",
        receivedAt: 25,
      },
      {
        botId: "b",
        channelId: "local:b",
        sourceKind: "bot",
        direction: "inbound",
        text: "private peer exchange",
        receivedAt: 30,
      },
    ],
    groupMessages: [
      {
        channelId: "g",
        direction: "outbound",
        status: "delivered",
        text: "shared result",
        receivedAt: 20,
      },
    ],
  };
  const rows = conversationList(data);
  assert.deepEqual(
    rows.map((r) => r.kind + ":" + r.id),
    ["group:g", "bot:a", "bot:b"],
  );
  assert.equal(rows[0].preview, "shared input");
  assert.equal(rows[1].preview, "private result");
  assert.equal(rows[2].preview, "开始聊天");
  assert.deepEqual(
    conversationList(data, "  ALICE ").map((r) => r.id),
    ["a"],
  );
  assert.deepEqual(
    conversationList(data, " TEAM").map((r) => r.id),
    ["g"],
  );
  assert.equal(conversationList(data, "unknown").length, 0);
});

test("a completed inbox is not a running bot; active workers and turns are", () => {
  const data: any = {
    turns: [{ botId: "a", status: "completed" }],
    jobs: [],
    requests: [],
    messages: [],
  };
  assert.equal(botActivity(data, "a"), "idle");
  data.jobs.push({ botId: "a", state: "running" });
  assert.equal(botActivity(data, "a"), "working");
  assert.equal(botActivity(data, "b"), "idle");
  data.jobs = [];
  data.turns.push({ botId: "a", status: "running" });
  assert.equal(botActivity(data, "a"), "working");
  data.requests.push({ botId: "a", status: "pending" });
  assert.equal(botActivity(data, "a"), "attention");
});

test("queued messages remain queued rather than pretending inference started", () => {
  assert.equal(
    botActivity(
      { messages: [{ botId: "a", direction: "inbound", status: "queued" }] },
      "a",
    ),
    "queued",
  );
  assert.equal(
    botActivity(
      { messages: [{ botId: "a", direction: "outbound", status: "queued" }] },
      "a",
    ),
    "idle",
  );
});
test("composer activity follows the latest task while historical failure cards remain recoverable", async () => {
  const { messageFailures } = await import("../src/gui/presentation.ts");
  const old = { botId: "a", messageId: "old", channelId: "local:a", direction: "inbound", status: "uncertain", receivedAt: 1 };
  const current = { botId: "a", messageId: "new", channelId: "local:a", direction: "inbound", status: "processed", receivedAt: 2 };
  const data: any = { messages: [current, old], turns: [{ botId: "a", status: "completed" }] };
  assert.equal(botActivity(data, "a"), "idle");
  assert.deepEqual(messageFailures(data, old), [old]);
  data.messages.push({ botId: "a", direction: "outbound", status: "delivered", receivedAt: 10 });
  current.status = "uncertain";
  assert.equal(botActivity(data, "a"), "interrupted", "an outbound reply does not prove its task succeeded");
  data.turns.push({ botId: "a", status: "running" });
  assert.equal(botActivity(data, "a"), "working");
  data.turns = []; data.requests = [{ botId: "a", status: "pending" }];
  assert.equal(botActivity(data, "a"), "attention");
});
test("a scoped human wait does not hide independent active work or become a forever-running job", () => {
  const data: any = { turns: [], messages: [], jobs: [{ botId: "a", taskId: "A", state: "running" }], requests: [{ botId: "a", status: "pending", kind: "approval", params: { taskId: "A" } }] };
  assert.equal(botActivity(data, "a"), "attention");
  data.jobs.push({ botId: "a", taskId: "B", state: "running" });
  assert.equal(botActivity(data, "a"), "working");
  data.jobs.pop(); data.turns.push({ botId: "a", taskId: "A", status: "running", inputIds: ["B-input"] });
  data.messages.push({ botId: "a", messageId: "B-input", taskId: "B", status: "processing" });
  assert.equal(botActivity(data, "a"), "working");
  data.turns = []; data.messages = []; data.requests[0].status = "resolved";
  assert.equal(botActivity(data, "a"), "working");
  data.jobs[0].state = "completed";
  assert.equal(botActivity(data, "a"), "idle");
});

test("absolute file paths become copyable segments without losing any text", () => {
  const text =
    "文件绝对路径：/Users/xiaoyang/Documents/Codex/2026-10-12/task-2/pi-bot/work/gui/demo/sessions/a/result.txt\n核对完成。";
  const segments = messageSegments(text);
  assert.equal(segments.map((s) => s.text).join(""), text);
  assert.deepEqual(
    segments.filter((s) => s.kind === "path").map((s) => s.text),
    [text.split("：")[1].split("\n")[0]],
  );
  assert.equal(messageSegments("https://example.com/a/b")[0].kind, "text");
  assert.equal(messageSegments("用 /login 和 /model 登录。")[0].kind, "text");
});

test("avatar identity stays stable when contacts are searched or reordered", () => {
  assert.equal(avatarVariant("bot-a"), avatarVariant("bot-a"));
  assert.ok(avatarVariant("bot-a") >= 0 && avatarVariant("bot-a") < 6);
});

test("global search covers contacts, messages and bot-owned routines without peer leakage", async () => {
  const { searchEverything } = await import("../src/gui/presentation.ts");
  const data: any = {
    bots: [{ id: "a", name: "Alice", createdAt: 1 }],
    groups: [{ id: "g", name: "Team", memberIds: ["a"], createdAt: 2 }],
    messages: [
      {
        messageId: "m",
        botId: "a",
        channelId: "local:a",
        direction: "outbound",
        status: "delivered",
        text: "found report 73",
        receivedAt: 3,
      },
      {
        messageId: "private",
        botId: "a",
        channelId: "local:a",
        sourceKind: "bot",
        direction: "inbound",
        text: "private report",
        receivedAt: 4,
      },
    ],
    groupMessages: [
      {
        messageId: "gm",
        channelId: "g",
        direction: "outbound",
        status: "delivered",
        text: "public report",
        receivedAt: 5,
      },
    ],
    states: {
      a: {
        proactive: {
          schedules: [{ id: "s", prompt: "report daily", state: "active" }],
          monitors: [{ id: "n", prompt: "CI failure", state: "paused" }],
        },
      },
    },
  };
  assert.deepEqual(
    searchEverything(data, "report")
      .filter((r: any) => r.kind === "message")
      .map((r: any) => r.id),
    ["gm", "m"],
  );
  assert.ok(
    searchEverything(data, "report").some(
      (r: any) => r.kind === "schedule" && r.botId === "a",
    ),
  );
  assert.ok(
    searchEverything(data, "CI").some((r: any) => r.kind === "monitor"),
  );
  assert.ok(searchEverything(data, "Alice").some((r: any) => r.kind === "bot"));
  assert.ok(
    searchEverything(data, "model").some((r: any) => r.kind === "action"),
  );
  assert.equal(searchEverything(data, "private").length, 0);
});

test("task failures are scoped, actionable and never expose raw provider secrets", async () => {
  const { taskFailure } = await import("../src/gui/presentation.ts");
  const m: any = {
    messageId: "m",
    status: "uncertain",
    error:
      "ContextBudgetError: Image inputs need a provider-specific context budget. No input or history was truncated.",
  };
  const issue = taskFailure(m);
  assert.ok(issue);
  assert.equal(issue.title, "回复未完成");
  assert.match(issue.description, /截图/);
  assert.doesNotMatch(issue.description, /review|审核/);
  assert.equal(taskFailure({ ...m, status: "processed" }), undefined);
  const generic = taskFailure({
    ...m,
    error: "Failed https://provider?api_key=secret",
  });
  assert.ok(!JSON.stringify(generic).includes("secret"));
  assert.ok(!JSON.stringify(generic).includes("https://"));
  assert.equal(
    taskFailure({ ...m, error: "request timeout" })!.code,
    "timeout",
  );
});

test("group failures attach to the public message and keep each bot and input correlation", async () => {
  const { messageFailures } = await import("../src/gui/presentation.ts");
  const data = {
    messages: [
      {
        messageId: "a-input",
        groupMessageId: "public",
        channelId: "g",
        botId: "a",
        direction: "inbound",
        status: "uncertain",
      },
      {
        messageId: "b-input",
        groupMessageId: "public",
        channelId: "g",
        botId: "b",
        direction: "inbound",
        status: "processed",
      },
      {
        messageId: "private",
        groupMessageId: "public",
        channelId: "other",
        botId: "c",
        direction: "inbound",
        status: "failed",
      },
      {messageId:'peer',groupMessageId:'public',channelId:'g',botId:'a',direction:'inbound',sourceKind:'bot',deliveryTarget:'direct',status:'uncertain'},
    ],
  };
  assert.deepEqual(
    messageFailures(data, {
      messageId: "public",
      channelId: "g",
      direction: "inbound",
      status: "received",
    }).map((m: any) => m.messageId),
    ["a-input"],
  );
  assert.equal(
    messageFailures(data, {
      messageId: "reply",
      channelId: "g",
      direction: "outbound",
      status: "delivered",
    }).length,
    0,
  );
});
