import React, { useEffect, useRef, useState } from "react";
import { Toast } from "radix-ui";
import { X, Info, WifiOff } from "lucide-react";
export function Notification({ text, onClose }) {
  return (
    <Toast.Provider duration={6500} label="提醒">
      <Toast.Root
        key={text}
        open={!!text}
        onOpenChange={(v) => {
          if (!v) onClose();
        }}
        className="operation-toast"
      >
        <Info size={17} />
        <Toast.Description>{text}</Toast.Description>
        <Toast.Close aria-label="关闭提醒">
          <X size={16} />
        </Toast.Close>
      </Toast.Root>
      <Toast.Viewport label="提醒（F8）" className="notification-viewport" />
    </Toast.Provider>
  );
}
export function ServiceNotice({ kind, children, action }) {
  return (
    <div className={"service-notice " + kind} role="status">
      {kind === "connection" ? <WifiOff size={15} /> : <Info size={15} />}
      <span>{children}</span>
      {action}
    </div>
  );
}

export function ConnectionFeedback({ phase, onSettings }) {
  const previous = useRef(phase);
  const [recovered, setRecovered] = useState(false);
  useEffect(() => {
    if (phase === "ready" && ["reconnecting", "failed"].includes(previous.current)) setRecovered(true);
    if (phase !== "ready") setRecovered(false);
    previous.current = phase;
    const timer = setTimeout(() => setRecovered(false), 3500);
    return () => clearTimeout(timer);
  }, [phase]);
  if (phase === "ready" && !recovered) return null;
  const labels = { disconnected: "尚未连接", connecting: "正在连接…", loading: "正在加载会话…", reconnecting: "连接中断 · 正在重连…", failed: "连接不可用" };
  return <div className="connection-feedback" role="status" data-phase={recovered ? "recovered" : phase}>
    <span className="connection-dot" aria-hidden="true" /><span>{recovered ? "已恢复连接" : labels[phase] || "离线"}</span>
    {["disconnected", "reconnecting", "failed"].includes(phase) && <button onClick={onSettings}>连接设置</button>}
  </div>;
}
