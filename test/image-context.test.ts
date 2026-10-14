import test from "node:test";
import assert from "node:assert/strict";
import {
  NonBlockingContextManager,
  estimateContextTokens,
} from "../src/pi/context.ts";
import {
  imageBudgetForModel,
  withVerifiedImageCapability,
} from "../src/pi/image-budget.ts";

test("official DeepSeek Flash screenshots fit context without changing native content", () => {
  const model: any = {
    provider: "deepseek",
    id: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    input: ["text"],
  };
  const current = withVerifiedImageCapability(model);
  assert.deepEqual(current.input, ["text", "image"]);
  assert.deepEqual(model.input, ["text"]);
  const image = {
    type: "image",
    data: Buffer.alloc(60000).toString("base64"),
    mimeType: "image/png",
  };
  const message: any = { role: "user", timestamp: 1, content: [image] };
  const budget = imageBudgetForModel(current);
  const context = new NonBlockingContextManager({
    getState: () => ({}),
    maxContextTokens: 5000,
    outputReserveTokens: 512,
    imageBudget: budget,
  });
  const result = context.preserveContext({
    sessionId: "test",
    messages: [message],
    historyRef: "native",
  });
  assert.ok(result.includes(message));
  assert.equal(message.content[0], image);
  assert.equal(image.data.length, 80000);
  assert.ok(estimateContextTokens([message], budget) < 1000);
  assert.throws(
    () =>
      new NonBlockingContextManager({ getState: () => ({}) }).preserveContext({
        sessionId: "test",
        messages: [message],
        historyRef: "native",
      }),
    /provider-specific/,
  );
});

test("image capability and budget do not extend to unknown providers or endpoints", () => {
  for (const model of [
    {
      provider: "deepseek",
      id: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com",
      input: ["text"],
    },
    {
      provider: "deepseek",
      id: "deepseek-v4-flash",
      baseUrl: "https://example.com",
      input: ["text"],
    },
    {
      provider: "custom",
      id: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      input: ["text"],
    },
  ]) {
    assert.equal(imageBudgetForModel(model as any), undefined);
    assert.deepEqual(withVerifiedImageCapability(model as any).input, ["text"]);
  }
});

test("oversize and too many images fail explicitly rather than clipping history", () => {
  const budget = imageBudgetForModel({
    provider: "deepseek",
    id: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    input: ["image"],
  } as any)!;
  const image: any = { type: "image", data: "AAAA", mimeType: "image/png" };
  assert.throws(
    () =>
      estimateContextTokens(
        [
          { role: "user", timestamp: 1, content: Array(601).fill(image) },
        ] as any,
        budget,
      ),
    /image count/,
  );
  assert.throws(
    () =>
      estimateContextTokens(
        [
          {
            role: "user",
            timestamp: 1,
            content: [{ ...image, data: "A".repeat(48 * 1024 * 1024) }],
          },
        ] as any,
        budget,
      ),
    /image size/,
  );
});

test("native screenshot tool batches preserve image bytes and exclude SDK-only diagnostics from provider accounting", () => {
  const budget = imageBudgetForModel({
    provider: "deepseek",
    id: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    input: ["image"],
  } as any)!;
  const image = {
    type: "image",
    data: Buffer.alloc(70000).toString("base64"),
    mimeType: "image/png",
  };
  const call: any = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "shot",
        name: "desktop_call",
        arguments: { kind: "computer", tool: "screenshot", args: {} },
      },
    ],
  };
  const result: any = {
    role: "toolResult",
    toolCallId: "shot",
    toolName: "desktop_call",
    content: [{ type: "text", text: "owned window" }, image],
    details: { diagnostics: "x".repeat(100000) },
    isError: false,
    timestamp: 1,
  };
  const manager = new NonBlockingContextManager({
    getState: () => ({}),
    maxContextTokens: 5000,
    outputReserveTokens: 512,
    imageBudget: budget,
  });
  const preserved = manager.preserveContext({
    sessionId: "native-tool-image",
    messages: [call, result],
    historyRef: "native",
  });
  assert.ok(preserved.includes(call));
  assert.ok(preserved.includes(result));
  assert.equal(result.content[1], image);
  assert.equal(result.details.diagnostics.length, 100000);
  assert.ok(estimateContextTokens([call, result], budget) < 1200);
});
