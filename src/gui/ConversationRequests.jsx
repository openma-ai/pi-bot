import React, { useState } from "react";
import { DecisionCard } from "./DecisionCard.jsx";
import { errorText } from "./useDaemon.js";
import { approvalTargets, requestsForConversation, safeCredentialPath } from "./conversation-requests.js";
function RequestCard({ request, api, baseUrl, owner }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function act(operation) {
    setBusy(true); setError("");
    try { await operation(); }
    catch (problem) { setError(problem?.reason ? errorText(problem) : String(problem.message || problem)); }
    finally { setBusy(false); }
  }
  if (request.kind === "question") return <DecisionCard request={request} onAnswer={(text) => api.request.resolve({ requestId: request.id, response: { text } })} />;
  const path = safeCredentialPath(request.params.formUrl);
  const resolved = request.status === "resolved";
  return <section className="decision-card" aria-label={request.kind === "approval" ? "工具审批" : "安全凭据请求"}>
    <strong>{owner ? `${owner} · ` : ""}{request.kind === "approval" ? "需要工具审批" : "需要安全输入凭据"}</strong>
    <p>{request.params.label || request.params.tool || request.params.text}</p>
    {request.kind === "approval" ? <>
      <dl className="approval-targets">{approvalTargets(request).map((field) => <React.Fragment key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></React.Fragment>)}</dl>
      <details><summary>完整工具参数</summary><pre>{JSON.stringify(request.params.args, null, 2)}</pre></details>
      {resolved ? <p className="request-outcome">{request.response?.decision === "approve" ? "已允许" : "已拒绝"}</p> : <div className="decision-options">
        <button disabled={busy} onClick={() => act(() => api.request.resolve({ requestId: request.id, response: { decision: "approve" } }))}>允许</button>
        <button disabled={busy} onClick={() => act(() => api.request.resolve({ requestId: request.id, response: { decision: "deny" } }))}>拒绝</button>
      </div>}
    </> : <>
      <p>凭据只在独立安全窗口输入，不会作为聊天消息发送。</p>
      {resolved ? <p className="request-outcome">安全输入已完成</p> : !path ? <p role="alert">安全表单不可用，请检查原 runtime 的请求状态。</p> : window.__PIBOT_NATIVE__ ?
        <button disabled={busy} onClick={() => act(() => window.__PIBOT_NATIVE__.call("credential_window", { path }))}>打开安全输入窗口</button> :
        <a href={baseUrl + path} target="_blank" rel="noreferrer">安全输入凭据</a>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
export function ConversationRequests({ data, kind, id, api, baseUrl = "" }) {
  const requests = requestsForConversation(data, kind, id, true);
  if (!requests.length) return null;
  return <div className="conversation-requests" aria-label="此会话需要你的操作">
    {requests.map((request) => <RequestCard key={request.id} request={request} api={api} baseUrl={baseUrl} owner={kind === "group" ? data.bots.find((bot) => bot.id === request.botId)?.name : undefined} />)}
  </div>;
}
