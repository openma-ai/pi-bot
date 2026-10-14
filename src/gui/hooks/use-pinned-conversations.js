import { useEffect, useState } from "react";
export const conversationKey = (row) => JSON.stringify([row.kind, row.id]);
export function togglePinned(keys, row) {
  const key = conversationKey(row);
  return keys.includes(key) ? keys.filter((value) => value !== key) : [...keys, key];
}
export function usePinnedConversations(scope) {
  const [all, setAll] = useState(() => {
    try { const value = JSON.parse(localStorage.getItem("pi-conversation-pins") || "{}"); return value && !Array.isArray(value) && typeof value === "object" ? value : {}; }
    catch { return {}; }
  });
  useEffect(() => { try { localStorage.setItem("pi-conversation-pins", JSON.stringify(all)); } catch {} }, [all]);
  const keys = Array.isArray(all[scope]) ? all[scope].filter((key) => typeof key === "string") : [];
  return { keys, toggle: (row) => setAll((old) => ({ ...old, [scope]: togglePinned(Array.isArray(old[scope]) ? old[scope] : [], row) })) };
}
