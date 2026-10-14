import React, { useEffect, useState } from "react";
import { AlertCircle, ChevronDown } from "lucide-react";
import { taskFailure } from "./presentation.ts";
export function TaskFailure({ message, api, onInspect, owner }) {
  const [plan, setPlan] = useState(),
    [busy, setBusy] = useState(false),
    [retryError, setRetryError] = useState("");
  const issue = taskFailure(message);
  useEffect(() => {
    let alive = true;
    if (issue && api)
      api.task
        .recovery({ inputId: message.messageId })
        .then((p) => {
          if (alive) setPlan(p);
        })
        .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, message.messageId, message.status]);
  if (!issue) return null;
  return (
    <div className="task-failure" role="status">
      <div className="task-failure-title">
        <AlertCircle size={14} />
        <span>
          {owner ? owner + "：" : ""}
          {issue.title}
        </span>
      </div>
      <p>{issue.description}</p>
      <div className="task-failure-actions">
        {plan?.canRetry && (
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setRetryError("");
              try {
                await api.task.reconcile({ inputId: message.messageId });
              } catch {
                setRetryError("当前状态已变化，未重复执行。请查看任务详情。");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "正在恢复…" : "继续处理"}
          </button>
        )}
        <button onClick={onInspect}>查看任务</button>
        <details>
          <summary>
            <ChevronDown size={12} />
            错误详情
          </summary>
          <span>原因：{issue.code}</span>
          <code>消息：{message.messageId}</code>
        </details>
      </div>
      {retryError && <p role="alert">{retryError}</p>}
    </div>
  );
}
