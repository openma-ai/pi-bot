import test from "node:test";
import assert from "node:assert/strict";
import {
  botActivity,
  messageSegments,
  avatarVariant,
} from "../src/gui/presentation.ts";

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
