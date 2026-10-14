import React from "react";
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
