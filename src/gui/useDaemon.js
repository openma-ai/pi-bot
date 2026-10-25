import { useEffect, useRef, useState } from "react";
import { completedMessages } from "./presentation.ts";
import { PiBotClient } from "../sdk/client.ts";
import { createDaemonStore } from "../sdk/state/reducer.ts";
const empty = {
  bots: [],
  groups: [],
  messages: [],
  states: {},
  requests: [],
  jobs: [],
  threads: [],
  turns: [],
};
const errors = {
  authenticationRequired:"登录已过期或被撤销，请在连接管理重新登录",
  notInitialized: "连接尚未准备好",
  setupRequired: "请先配置 Pi 模型和认证",
  budgetExhausted: "本轮已达到运行保护限制，可查看任务状态",
  shuttingDown: "服务正在关闭",
  reviewRequired: "已保留执行记录，为避免重复操作，请查看任务状态",
  conflict: "同一操作已提交不同内容",
  forbidden: "该操作不在允许范围内",
  capacity: "当前容量已满",
  invalidParams: "请检查输入内容",
  notFound: "内容已不存在",
  taskCancelled: "任务已取消或被替换",
  internal: "操作失败，请检查任务状态",
};
export const errorText = (e) => errors[e?.reason] ?? "操作未完成，请稍后重试";
function view(snapshot, state) {
  const values = (key) => Object.values(state[key]);
  const bots = values("bots"),
    items = values("items"),
    routines = values("routines"),
    requests = values("requests");
  const messages = completedMessages(items);
  const states = Object.fromEntries(
    bots.map((b) => {
      const inbox = messages.filter(
        (m) =>
          m.botId === b.id &&
          m.direction === "inbound" &&
          ["queued", "processing", "uncertain"].includes(m.status),
      );
      const jobs = values("jobs").filter((j) => j.botId === b.id);
      const questions = requests
        .filter(
          (q) =>
            q.botId === b.id && q.kind === "question" && q.status === "pending",
        )
        .map((q) => ({ id: q.params.questionId, text: q.params.text }));
      return [
        b.id,
        {
          inbox,
          jobs,
          questions,
          counts: {
            inbox: inbox.length,
            jobs: jobs.filter((j) => j.state === "running").length,
            questions: questions.length,
            outbox: 0,
          },
          proactive: {
            schedules: routines
              .filter((r) => r.botId === b.id && r.kind === "schedule")
              .map((r) => ({ ...r, id: r.id.slice(9) })),
            monitors: routines
              .filter((r) => r.botId === b.id && r.kind === "monitor")
              .map((r) => ({ ...r, id: r.id.slice(8) })),
          },
        },
      ];
    }),
  );
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    reasoning: 0,
    totalTokens: 0,
    estimatedUsd: 0,
  };
  for (const t of values("turns"))
    if (t.usage) {
      for (const k of [
        "input",
        "output",
        "cacheRead",
        "reasoning",
        "totalTokens",
      ])
        usage[k] += t.usage[k] ?? 0;
      usage.estimatedUsd += t.usage.costUsd ?? 0;
    }
  return {
    ...snapshot,
    seq: state.seq,
    status: state.status,
    bots,
    groups: values("groups"),
    threads: values("threads"),
    turns: values("turns"),
    jobs: values("jobs"),
    requests,
    items,
    streaming: state.streaming,
    streamingScopes: state.streamingScopes,
    groupMessages: snapshot.groupMessages ?? [],
    messages,
    states,
    usage,
  };
}
export function useDaemon(baseUrl = "") {
  const [data, setData] = useState(empty),
    [client, setClient] = useState(),
    [error, setError] = useState(""),
    [phase, setPhase] = useState("disconnected");
  const current = useRef();
  useEffect(() => {
    if (baseUrl === null) {
      setData(empty);
      setClient(undefined);
      setError("未连接 server");
      setPhase("disconnected");
      return;
    }
    setData(empty); setClient(undefined); setError(""); setPhase("connecting");
    let stopped = false,
      initialized = false,
      connection,
      unsubscribe;
    let metadata, store;
    const publish = () => {
      if (!stopped) setData(view(metadata, store.get()));
    };
    async function snapshot() {
      metadata = await connection.daemon.snapshot({});
      store = createDaemonStore(metadata);
      unsubscribe = await connection.events.subscribe(
        { after: metadata.seq },
        (event) => {
          if (
            event.method === "daemon/configurationChanged" ||
            event.method === "daemon/budgetUpdated" ||
            event.method === "daemon/triggerChanged"
          )
            metadata = { ...metadata, ...event.params };
          if (event.method === "group/messageUpdated") {
            const messages = new Map(
              (metadata.groupMessages ?? []).map((m) => [m.messageId, m]),
            );
            messages.set(event.params.message.messageId, event.params.message);
            metadata = { ...metadata, groupMessages: [...messages.values()] };
          }
          store.apply(event);
          publish();
          if (event.seq !== null)
            void connection.events.ack(event.seq).catch(() => {});
        },
      );
      publish();
    }
    void (async () => {
      try {
        connection = await PiBotClient.connect({
          transport: { http: baseUrl },
          // The native bridge authenticates each request in Rust. It has no browser
          // session cookie or HTML CSRF bootstrap to refresh after an SSE outage.
          ...(window.__PIBOT_NATIVE__ ? { auth: async () => ({}) } : {}),
          capabilities: {
            streamingReplies: true,
            serverRequests: ["approval", "question", "credential"],
          },
          clientInfo: { name: "pi-bot-gui", version: "0.2.0" },
        });
        if (stopped) {
          connection.close();
          return;
        }
        current.current = connection;
        setPhase("loading");
        connection.on("disconnected", () => {
          if (!stopped) { setError("连接中断，正在重连…"); setPhase("reconnecting"); setClient(undefined); }
        });
        connection.on("connected", () => {
          if (!stopped) { setError(""); if (initialized) { setPhase("ready"); setClient(connection); } }
        });
        connection.on("authenticationRequired",()=>{if(!stopped){setError(errors.authenticationRequired);setPhase("failed");setClient(undefined);}});
        connection.on("cursorExpired", () => {
          unsubscribe?.();
          void snapshot().catch((e) => setError(errorText(e)));
        });
        await snapshot();
        initialized = true;
        if (!stopped) { setClient(connection); setPhase("ready"); }
      } catch (e) {
        if (!stopped) { setError(errorText(e)); setPhase("failed"); }
      }
    })();
    return () => {
      stopped = true;
      unsubscribe?.();
      connection?.close();
      current.current = undefined;
    };
  }, [baseUrl]);
  return { data, client, error, phase };
}
