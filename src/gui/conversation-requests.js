export function requestsForConversation(data, kind, id, includeResolved = false) {
  const groupIds = new Set((data.groups || []).map((group) => group.id));
  return (data.requests || []).filter((request) => {
    if (request.status !== "pending" && !(includeResolved && request.status === "resolved")) return false;
    const thread = (data.threads || []).find((row) => row.id === request.threadId);
    const channel = thread?.scope?.channelId;
    return kind === "group"
      ? channel === id
      : request.botId === id && !groupIds.has(channel);
  });
}
export function approvalTargets(request) {
  const fields = [];
  function collect(value, prefix = "") {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (/command|cmd|path|file|url|uri|target|destination|host|permission|scope|operation|action|reason|risk/i.test(key)) {
        fields.push({ label: name, value: typeof item === "string" ? item : JSON.stringify(item) });
      } else if (item && typeof item === "object") collect(item, name);
    }
  }
  collect(request.params.args);
  return fields;
}
export function safeCredentialPath(path) {
  return typeof path === "string" && /^\/credential\/[a-zA-Z0-9_-]{1,256}$/.test(path) ? path : null;
}
