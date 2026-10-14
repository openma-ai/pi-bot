import React, { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check, FileText } from "lucide-react";
import { messageSegments } from "./presentation.ts";

function FilePath({ path }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  return (
    <span className="file-path">
      <FileText size={16} aria-hidden="true" />
      <code tabIndex={0} title={path}>
        {path}
      </code>
      <button
        aria-label={copied ? "路径已复制" : "复制完整路径"}
        title={error || "复制完整路径"}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(path);
            setCopied(true);
            setError("");
          } catch {
            setError("无法复制，请选择路径复制");
          }
        }}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
      {error && <span role="status">{error}</span>}
    </span>
  );
}
export function MessageBody({ text = "" }) {
  return (
    <div className="message-body">
      {messageSegments(text).map((s, i) =>
        s.kind === "path" ? (
          <FilePath key={i} path={s.text} />
        ) : (
          <Markdown
            key={i}
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              a: ({ node, ...props }) => (
                <a {...props} target="_blank" rel="noreferrer" />
              ),
              img: ({ alt }) => <span>[图片：{alt || "附件"}]</span>,
            }}
          >
            {s.text}
          </Markdown>
        ),
      )}
    </div>
  );
}
