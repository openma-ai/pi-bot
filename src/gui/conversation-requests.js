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
export function requestCardId(id) { return `conversation-request-${encodeURIComponent(id)}`; }
/** Move only the message scroller; don't move the page/header or answer a request. */
export function focusConversationRequest(id, root = document) {
  const card = root.getElementById(requestCardId(id));
  if (!card) return false;
  const scroller = card.closest('.conversation');
  if (!scroller) return false;
  const top = scroller.scrollTop + card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  card.focus({ preventScroll: true });
  return true;
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
