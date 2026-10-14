export function botActivity(data: any, id: string): string {
  const owned = (items: any[] = []) => items.filter((i) => i.botId === id);
  if (
    owned(data.requests).some((r) => r.status === "pending") ||
    owned(data.messages).some(
      (m) => m.direction === "inbound" && m.status === "uncertain",
    )
  )
    return "attention";
  if (
    owned(data.turns).some((t) => t.status === "running") ||
    owned(data.jobs).some((j) => j.state === "running")
  )
    return "working";
  if (
    owned(data.messages).some(
      (m) =>
        m.direction === "inbound" &&
        ["queued", "processing"].includes(m.status),
    )
  )
    return "queued";
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
