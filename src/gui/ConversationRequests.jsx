import React, { useRef, useState } from "react";
import { DecisionCard } from "./DecisionCard.jsx";
import { errorText } from "./useDaemon.js";
import { approvalTargets, focusConversationRequest, requestCardId, requestsForConversation, safeCredentialPath } from "./conversation-requests.js";
import "./request-attention.css";
function RequestCard({ request, api, baseUrl, owner }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [submittedDecision, setSubmittedDecision] = useState("");
  const actionPending = useRef(false);
  async function act(operation) {
    if (actionPending.current || !api) return;
    actionPending.current = true;
    setBusy(true); setError("");
    try { await operation(); }
    catch (problem) { setError(problem?.reason ? errorText(problem) : String(problem.message || problem)); }
    finally { actionPending.current = false; setBusy(false); }
  }
  if (request.kind === "question") return <DecisionCard request={request} disabled={!api} onAnswer={(text) => api.request.resolve({ requestId: request.id, response: { text } })} />;
  const path = safeCredentialPath(request.params.formUrl);
  const resolved = request.status === "resolved" || !!submittedDecision;
  const decision = request.response?.decision || submittedDecision;
  return <section className="decision-card" aria-label={request.kind === "approval" ? "工具审批" : "安全凭据请求"}>
    <strong>{owner ? `${owner} · ` : ""}{request.kind === "approval" ? "需要工具审批" : "需要安全输入凭据"}</strong>
    <p>{request.params.label || request.params.tool || request.params.text}</p>
    {request.kind === "approval" ? <>
      <dl className="approval-targets">{approvalTargets(request).map((field) => <React.Fragment key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></React.Fragment>)}</dl>
      <details><summary>完整工具参数</summary><pre>{JSON.stringify(request.params.args, null, 2)}</pre></details>
      {resolved ? <p className="request-outcome">{decision === "approve" ? "已允许" : "已拒绝"}</p> : <div className="decision-options">
        <button disabled={!api || busy} onClick={() => act(async () => { await api.request.resolve({ requestId: request.id, response: { decision: "approve" } }); setSubmittedDecision("approve"); })}>允许</button>
        <button disabled={!api || busy} onClick={() => act(async () => { await api.request.resolve({ requestId: request.id, response: { decision: "deny" } }); setSubmittedDecision("deny"); })}>拒绝</button>
      </div>}
    </> : <>
      <p>凭据只在独立安全窗口输入，不会作为聊天消息发送。</p>
      {resolved ? <p className="request-outcome">安全输入已完成</p> : !api ? <p>连接后可处理此请求。</p> : !path ? <p role="alert">安全表单不可用，请检查原 runtime 的请求状态。</p> : window.__PIBOT_NATIVE__ ?
        <button disabled={!api || busy} onClick={() => act(() => window.__PIBOT_NATIVE__.call("credential_window", { path }))}>打开安全输入窗口</button> :
        <a href={baseUrl + path} target="_blank" rel="noreferrer">安全输入凭据</a>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
export function ConversationRequests({ data, kind, id, api, baseUrl = "" }) {
  const requests = requestsForConversation(data, kind, id, true);
  if (!requests.length) return null;
  return <div className="conversation-requests" aria-label="此会话需要你的操作">
    {requests.map((request) => <div key={request.id} id={requestCardId(request.id)} className="conversation-request-target" tabIndex={-1}>
      <RequestCard request={request} api={api} baseUrl={baseUrl} owner={kind === "group" ? data.bots.find((bot) => bot.id === request.botId)?.name : undefined} />
    </div>)}
  </div>;
}
/** Keep beside the composer, outside the scrolling message list. Viewing never approves. */
export function RequestAttention({ data, kind, id, api, baseUrl = "" }) {
  const [expanded, setExpanded] = useState("");
  const requests = requestsForConversation(data, kind, id);
  if (!requests.length) return null;
  const first = requests[0], label = first.kind === "approval" ? "工具审批" : first.kind === "credential" ? "安全输入" : "问题待回答";
  return <aside className="request-attention" aria-label="待处理请求">
    <div className="request-attention-summary">
      <span><strong>{requests.length} 项待处理</strong><span className="request-attention-kind">{label}</span></span>
      <button type="button" aria-controls={requestCardId(first.id)} onClick={() => {
        if (!focusConversationRequest(first.id)) setExpanded(first.id);
      }}>查看请求</button>
    </div>
    {expanded === first.id && <div className="request-attention-fallback">
      <RequestCard key={first.id} request={first} api={api} baseUrl={baseUrl} owner={kind === "group" ? data.bots.find(bot => bot.id === first.botId)?.name : undefined}/>
    </div>}
  </aside>;
}
