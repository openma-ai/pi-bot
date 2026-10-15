import { useEffect, useState } from "react";
export function parseConversationRoute(hash) {
  if (hash === "#/conversations" || !hash) return { page: "list" };
  const match = /^#\/chat\/(bot|group)\/([^/]+)$/.exec(hash);
  if (!match) return { page: "list" };
  try {
    const id = decodeURIComponent(match[2]);
    return id && id.length <= 256 ? { page: "chat", kind: match[1], id } : { page: "list" };
  } catch { return { page: "list" }; }
}
export function conversationHash(kind, id) {
  return `#/chat/${kind}/${encodeURIComponent(id)}`;
}
export function useConversationRoute() {
  const [route, setRoute] = useState(() => parseConversationRoute(location.hash));
  useEffect(() => {
    const update = () => setRoute(parseConversationRoute(location.hash));
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    return () => { window.removeEventListener("popstate", update); window.removeEventListener("hashchange", update); };
  }, []);
  const open = (kind, id, routeState = {}) => {
    const hash = conversationHash(kind, id);
    if (location.hash !== hash) history.pushState({ ...routeState, piConversation: true }, "", hash);
    setRoute(parseConversationRoute(hash));
  };
  const back = () => {
    if (history.state?.piConversation) history.back();
    else { history.replaceState(null, "", "#/conversations"); setRoute({ page: "list" }); }
  };
  const list = () => { history.replaceState(null, "", "#/conversations"); setRoute({ page: "list" }); };
  return { route, open, back, list };
}
