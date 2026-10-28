import { readProviderFailure } from '../sdk/provider-failure.ts';
// Only persisted, delivered messages are presentable. Delta buffers remain
// transport state and never become bubbles, previews, or replacement messages.
export function completedMessages(items: any[]): any[] {
  const messages = new Map<string, any>();
  for (const item of items) {
    const m = item.message;
    if (!m || (m.direction === "outbound" && m.status !== "delivered")) continue;
    messages.set(JSON.stringify([m.direction, m.messageId]), m);
  }
  return [...messages.values()].sort((a, b) => a.receivedAt - b.receivedAt);
}

export function previewText(text: string): string {
  try {
    const value = JSON.parse(text);
    if (typeof value.questionId === "string") {
      if (typeof value.question === "string") return value.question;
      if (typeof value.answer === "string") return value.answer;
    }
    if (typeof value.prompt === "string") return value.prompt;
  } catch {}
  return text;
}
export function conversationList(data: any, search = ""): Array<any> {
  const visible = (m: any) =>
    m.sourceKind !== "job" &&
    m.deliveryTarget !== "direct" &&
    !(m.direction === "inbound" && m.sourceKind === "bot") &&
    (m.direction !== "outbound" || m.status === "delivered");
  const latest = (messages: any[]) =>
    messages.reduce(
      (last, m) => (!last || m.receivedAt > last.receivedAt ? m : last),
      undefined,
    );
  const bots = (data.bots ?? []).map((b: any) => {
    const message = latest(
      (data.messages ?? []).filter(
        (m: any) =>
          visible(m) &&
          m.botId === b.id &&
          m.channelId === (b.channelId || `local:${b.id}`),
      ),
    );
    return {
      kind: "bot",
      id: b.id,
      name: b.name,
      bot: b,
      preview: message ? previewText(message.text) : "开始聊天",
      updatedAt: message?.receivedAt ?? b.createdAt,
    };
  });
  const groups = (data.groups ?? []).map((g: any) => {
    const message = latest(
      [...(data.groupMessages ?? []), ...(data.messages ?? [])].filter(
        (m: any) => visible(m) && m.channelId === g.id,
      ),
    );
    return {
      kind: "group",
      id: g.id,
      name: g.name,
      group: g,
      preview: message
        ? previewText(message.text)
        : `${g.memberIds.length} 位成员`,
      updatedAt: message?.receivedAt ?? g.createdAt,
    };
  });
  const query = search.trim().toLocaleLowerCase();
  return [...bots, ...groups]
    .filter((r) => r.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function botActivity(data: any, id: string): string {
  const owned = (items: any[] = []) => items.filter((i) => i.botId === id);
  const pending = owned(data.requests).filter((r) => r.status === "pending");
  const waitingTasks = new Set(pending.map((r) => r.params?.taskId).filter(Boolean));
  const executing = (item: any) => item.taskId ? !waitingTasks.has(item.taskId) : !pending.length;
  const executingTurn = (turn: any) => executing(turn) || (turn.inputIds || []).some((id: string) =>
    owned(data.messages).some((m) => m.messageId === id && m.status === "processing" && m.taskId && !waitingTasks.has(m.taskId)));
  if (
    owned(data.turns).some((t) => t.status === "running" && executingTurn(t)) ||
    owned(data.jobs).some((j) => j.state === "running" && executing(j))
  )
    return "working";
  if (pending.length) return "attention";
  if (
    owned(data.messages).some(
      (m) =>
        m.direction === "inbound" &&
        ["queued", "processing"].includes(m.status),
    )
  )
    return "queued";
  if (
    owned(data.messages).some(
      (m) =>
        m.direction === "inbound" && ["uncertain", "failed"].includes(m.status),
    )
  )
    return "interrupted";
  return "idle";
}
export function messageSegments(
  text: string,
): Array<{ kind: string; text: string }> {
  // Recognise bare absolute paths, never URL slashes or slash commands. Keep all bytes.
  const path =
    /(?<![\w/:`])(?:\/(?:Users|home|tmp|workspace|work|var|opt|root|mnt)\/)[^\s<>`，。；]+/g;
  const segments = [];
  let offset = 0;
  for (const match of text.matchAll(path)) {
    if (match.index > offset)
      segments.push({ kind: "text", text: text.slice(offset, match.index) });
    segments.push({ kind: "path", text: match[0] });
    offset = match.index + match[0].length;
  }
  if (offset < text.length || !segments.length)
    segments.push({ kind: "text", text: text.slice(offset) });
  return segments;
}
export function avatarVariant(id: string): number {
  return (
    Array.from(id).reduce((hash, c) => (hash * 31 + c.charCodeAt(0)) >>> 0, 0) %
    6
  );
}

/** Search only user-visible records; peer deliveries and worker internals stay private. */
export function searchEverything(data: any, query = ""): Array<any> {
  const contacts = conversationList(data);
  const actions = [
    {
      id: "settings",
      name: "设置",
      keywords: "login model settings auth runtime ssh cloud 本机 登录 模型 设置",
    },
    { id: "new-bot", name: "新建 bot", keywords: "create bot 助手" },
    { id: "new-group", name: "新建群聊", keywords: "create group 群聊" },
    {
      id: "requests",
      name: "待处理问题",
      keywords: "question decision 问题 决策",
    },
  ].map((a) => ({ ...a, kind: "action" }));
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...contacts, ...actions];
  const results = [...contacts, ...actions];
  const seen = new Set<string>();
  for (const m of [
    ...(data.groupMessages ?? []),
    ...(data.messages ?? []),
  ].sort((a, b) => b.receivedAt - a.receivedAt)) {
    if (
      seen.has(m.messageId) ||
      m.sourceKind === "job" ||
      m.deliveryTarget === "direct" ||
      (m.direction === "inbound" && m.sourceKind === "bot") ||
      (m.direction === "outbound" && m.status !== "delivered")
    )
      continue;
    const owner = contacts.find((c) =>
      c.kind === "group"
        ? c.id === m.channelId
        : c.id === m.botId &&
          (c.bot.channelId || `local:${c.id}`) === m.channelId,
    );
    if (!owner) continue;
    seen.add(m.messageId);
    results.push({
      kind: "message",
      id: m.messageId,
      name: previewText(m.text),
      subtitle: owner.name,
      owner,
    });
  }
  for (const b of data.bots ?? [])
    for (const [kind, key] of [
      ["schedule", "schedules"],
      ["monitor", "monitors"],
    ]) {
      for (const r of data.states?.[b.id]?.proactive?.[key] ?? [])
        results.push({
          kind,
          id: r.id,
          botId: b.id,
          name: r.prompt,
          subtitle: `${b.name} · ${kind === "schedule" ? "定时任务" : "监控"}`,
        });
    }
  return results.filter((r) =>
    `${r.name} ${r.subtitle ?? ""} ${r.keywords ?? ""}`
      .toLocaleLowerCase()
      .includes(q),
  );
}

export function taskFailure(
  message: any,
): { title: string; description: string; code: string; httpStatus?: number; providerCode?: string; retry?: string } | undefined {
  if (!["uncertain", "failed"].includes(message.status)) return undefined;
  const error = String(message.error ?? "");
  const provider = readProviderFailure(error);
  if (provider) {
    const labels = {
      authentication: ["模型认证未通过", "请在模型设置中检查当前连接。"],
      permission: ["模型访问权限不足", "请检查账号权限或选择其他可用模型。"],
      "rate-limit": ["模型请求受到限流", "请稍后检查任务状态，再决定是否继续。"],
      quota: ["模型用量受到限制", "请检查账号的方案与用量限制。"],
      model: ["所选模型不可用", "请在模型设置中重新检查可用型号。"],
      request: ["模型请求未被接受", "请检查模型与运行环境配置。"],
      network: ["模型服务连接异常", "请检查网络连接，已有任务记录已保留。"],
      timeout: ["模型请求超时", "请先查看任务记录，再决定是否继续。"],
      service: ["模型服务暂时不可用", "请稍后检查任务状态，再决定是否继续。"],
      unknown: ["模型请求失败", "未获得可安全展示的具体原因，请查看任务详情。"],
    };
    const [title, description] = labels[provider.category];
    return { title, description, code: `provider.${provider.category}`, httpStatus: provider.httpStatus,
      providerCode: provider.providerCode, retry: provider.retry };
  }
  if (/Image inputs need a provider-specific/.test(error))
    return {
      title: "回复未完成",
      description:
        "截图已返回，后续模型请求被图片上下文检查中断。聊天记录已保留。",
      code: "imageContext",
    };
  if (/timeout|timed out|超时/i.test(error))
    return {
      title: "执行超时",
      description: "模型或工具未在规定时间内完成。已有执行记录已保留。",
      code: "timeout",
    };
  if (/before streaming|request refused/i.test(error))
    return {
      title: "模型暂时无法响应",
      description: "本次请求未开始执行，可以重新尝试。",
      code: "providerUnavailable",
    };
  if (/context|budget|token/i.test(error))
    return {
      title: "本轮执行已停止",
      description: "请求达到上下文或运行保护限制。已有记录已保留。",
      code: "runtimeLimit",
    };
  if (/restart|process ended/i.test(error))
    return {
      title: "连接中断时任务尚未完成",
      description: "服务重启前的执行记录已保留，尚未重复执行。",
      code: "interrupted",
    };
  return {
    title: "执行未完成",
    description: "这条任务遇到错误。已保留消息和执行记录，可查看任务详情。",
    code: "executionFailed",
  };
}

export function messageFailures(data: any, message: any): any[] {
  if (message.direction !== "inbound") return [];
  if (["uncertain", "failed"].includes(message.status)) return [message];
  return (data.messages ?? []).filter(
    (m: any) =>
      m.groupMessageId === message.messageId &&
      m.channelId === message.channelId &&
      m.direction === "inbound" &&
      m.deliveryTarget !== "direct" &&
      !["bot", "job"].includes(m.sourceKind) &&
      ["uncertain", "failed"].includes(m.status),
  );
}
