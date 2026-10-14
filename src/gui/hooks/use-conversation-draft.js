import { useEffect, useState } from "react";
export function useConversationDraft(scope) {
  const [drafts, setDrafts] = useState(() => {
    try {
      const value = JSON.parse(
        sessionStorage.getItem("pi-chat-drafts") || "{}",
      );
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem("pi-chat-drafts", JSON.stringify(drafts));
    } catch {
      /* Storage can be disabled; in-memory editing still works. */
    }
  }, [drafts]);
  const draft = typeof drafts[scope] === "string" ? drafts[scope] : "";
  const setDraft = (value) =>
    setDrafts((old) => ({
      ...old,
      [scope]:
        typeof value === "function"
          ? value(typeof old[scope] === "string" ? old[scope] : "")
          : value,
    }));
  return [draft, setDraft];
}
