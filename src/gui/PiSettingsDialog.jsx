import React, { useEffect, useState, useRef, useMemo } from "react";
import {
  Flex,
  Text,
  TextField,
  Button,
  Skeleton,
} from "@radix-ui/themes";
import {
  Check,
  KeyRound,
  LogIn,
  MoreHorizontal,
  CircleAlert,
  RefreshCw,
  LoaderCircle,
  ArrowLeft,
  ChevronRight,
} from "lucide-react";
import { DropdownMenu } from "@radix-ui/themes";
import { createPiSettingsClient } from "../sdk/pi-settings-client.ts";
import { createPiLoginFlow } from "./pi-login-flow.ts";
import { piLoginPresentation, piProviderConfigured, piCatalogNote } from "./pi-login-presentation.ts";
import {Choice} from "./PiChoice.jsx";
import {ConnectionEditor,ConnectionList} from "./PiConnections.jsx";
import {piConnections,piModelOptions,currentConnectionId} from "./pi-connections.ts";
import { piThinkingSelection } from "./pi-thinking.ts";
const safeLink = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname))
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};
function SettingsError({ error, onRetry, busy }) {
  return (
    <div className="pi-settings-error" role="alert">
      <CircleAlert size={17} />
      <div>
        <Text as="p" size="2" weight="medium">
          {error.message || "暂时无法读取 Pi 设置"}
        </Text>
        {error.code === "connectionLost" && (
          <Text as="p" size="1" color="gray">
            {error.submitted
              ? "先刷新状态，再决定是否重试。认证和聊天记录不会被清除。"
              : error.status
                ? "请检查当前 runtime 的连接。恢复后可重新加载。"
                : "网页客户端未响应，请恢复连接后重新加载。"}
          </Text>
        )}
      </div>
      <Button
        size="1"
        variant="ghost"
        color="gray"
        disabled={busy}
        onClick={onRetry}
      >
        <RefreshCw size={13} />
        重新加载
      </Button>
    </div>
  );
}
export function PiSettingsPanel({ baseUrl = "", registerBeforeSwitch, runtimeLabel = "当前工作空间", onConfigured, callbackPlacement = "unknown" }) {
  const request = useMemo(() => createPiSettingsClient(baseUrl), [baseUrl]);
  const alive = useRef(false), scope = useRef(0), controller = useRef();
  const pendingAction = useRef(false), promptId = useRef();
  const [config, setConfig] = useState(),
    [provider, setProvider] = useState(""),
    [connectionId,setConnectionId]=useState(""),
    [authConnectionId,setAuthConnectionId]=useState(""),
    [showMethods,setShowMethods]=useState(false),
    [editing,setEditing]=useState(null),
    [removeConfirm,setRemoveConfirm]=useState(false),
    [nativeConnections,setNativeConnections]=useState(!window.__PIBOT_NATIVE__),
    [authProvider, setAuthProvider] = useState(""),
    [section, setSection] = useState("use"),
    [model, setModel] = useState(""),
    [thinking, setThinking] = useState("high"),
    [flow, setFlow] = useState(),
    [value, setValue] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [openedFlow, setOpenedFlow] = useState("");
  const native = !!window.__PIBOT_NATIVE__;
  async function refresh(initial = false) {
    const version = scope.current;
    const data = await request("config");
    if (!alive.current || version !== scope.current) return;
    setConfig(data);
    if (initial) {
      // Browsing an authentication provider is not a draft model selection.
      setProvider(data.current.provider || "");
      setConnectionId(currentConnectionId(data));
      setAuthConnectionId(currentConnectionId(data)||piConnections(data)[0]?.id||"");
      setShowMethods(false);
      setModel(data.current.model || "");
      setThinking(data.current.thinkingLevel || "high");
      setAuthProvider(data.current.provider || data.providers.find(p => piProviderConfigured(p))?.id ||
        data.providers.find(p => p.id === "openai")?.id || data.providers[0]?.id || "");
      setSection(data.providers.some(p => piProviderConfigured(p) || p.credential) || piConnections(data).some(c=>c.configured) ? "use" : Array.isArray(data.connections) ? (data.connections.length ? "connections" : "add") : "auth");
    }
    return data;
  }
  useEffect(() => {
    alive.current = true; scope.current++;
    setConfig(undefined); setFlow(undefined); setError(""); setNotice("");
    const version = scope.current;
    if (native) void window.__PIBOT_NATIVE__.call("pi_settings_capabilities").then(cap=>{if(alive.current&&version===scope.current)setNativeConnections(cap?.modelConnectionsVersion>=1);}).catch(()=>{});
    controller.current = createPiLoginFlow(request, next => {
      if (alive.current && version === scope.current) {
        if (promptId.current !== next?.prompt?.id) setValue("");
        promptId.current = next?.prompt?.id;
        setFlow(next);
      }
    });
    void refresh(true).catch(e => { if(alive.current && version === scope.current) setError(e); });
    return () => { alive.current = false; scope.current++; controller.current?.dispose(); };
  }, [request]);
  useEffect(() => {
    if (flow?.status !== "pending") return;
    const poll = () => void controller.current?.poll();
    poll();
    const timer = setInterval(poll, 600);
    return () => clearInterval(timer);
  }, [flow?.id, flow?.status]);
  useEffect(() => {
    if (flow?.status !== "complete") return;
    const version = scope.current;
    void closeFlowWindows(flow.id);
    void refresh().then(data => {
      if(alive.current && version === scope.current) confirmConnection(data);
    }).catch(e => { if(alive.current && version === scope.current) setError(e); });
  }, [flow?.id, flow?.status]);
  useEffect(() => registerBeforeSwitch?.(async () => {
    await controller.current?.cancel(); setValue("");
  }), [registerBeforeSwitch, request]);
  const connections=piConnections(config),modern=Array.isArray(config?.connections);
  const authConnection=connections.find(c=>c.id===authConnectionId);
  const providerAccount=config?.providers.find(p=>p.id===(authConnection?.providerId||authProvider));
  const account=authConnection ? {...providerAccount,...authConnection,id:authConnection.providerId} : providerAccount;
  const models=piModelOptions(config);
  const selected=connections.find(c=>c.id===connectionId);
  const visibleCatalog=selected?.catalog || connections.find(c=>c.configured||c.credential)?.catalog || config?.catalog;
  const selectedModel=selected?.models?.find(m=>m.id===model);
  const thinkingSelection=piThinkingSelection(selectedModel,thinking);
  const validModel=piProviderConfigured(selected)&&!!selectedModel;
  const active=flow?.status==="pending";
  const presentation=piLoginPresentation(flow,callbackPlacement);
  const confirming=flow?.status==="complete"&&section==="auth";
  const hasConnection=connections.length>0;
  const configured=connections.some(c=>c.configured&&c.id===currentConnectionId(config)&&c.models.some(m=>m.id===config.current.model));
  const dirty=!!config&&validModel&&(connectionId!==currentConnectionId(config)||provider!==config.current.provider||model!==config.current.model||thinking!==config.current.thinkingLevel);
  const routeEpoch=useRef(0), routeOwner=useRef(crypto.randomUUID()), routeFromPop=useRef(false), routeClaimed=useRef(false);
  useEffect(()=>{
    if(!config)return;
    if(routeFromPop.current){routeFromPop.current=false;return;}
    const state={...history.state,piSettingsRoute:{owner:routeOwner.current,section,connectionId:authConnectionId}};
    if(!routeClaimed.current){history.replaceState(state,"");routeClaimed.current=true;}else history.pushState(state,"");
  },[!!config,section,authConnectionId]);
  useEffect(()=>{
    const pop=event=>{
      const route=event.state?.piSettingsRoute;if(route?.owner!==routeOwner.current)return;
      routeEpoch.current++;routeFromPop.current=true;void controller.current?.cancel();setValue("");setError("");setNotice("");setRemoveConfirm(false);
      const saved=piConnections(config).find(c=>c.id===route.connectionId);
      setAuthConnectionId(saved?.id||"");setEditing(route.section==="edit"?saved:null);setShowMethods(false);
      setSection(["auth","edit"].includes(route.section)&&!saved?"connections":route.section);
    };
    window.addEventListener("popstate",pop);return()=>window.removeEventListener("popstate",pop);
  },[config]);
  const effectiveError = error || (flow?.error ? {message:flow.error,code:flow.errorCode,submitted:flow.uncertain} : undefined);
  async function act(fn) {
    if (pendingAction.current) return;
    pendingAction.current = true; setBusy(true); setError(""); setNotice("");
    const version = scope.current;
    try { await fn(); }
    catch (e) { if(alive.current && version === scope.current) setError(e); }
    finally { pendingAction.current = false; if(alive.current && version === scope.current) setBusy(false); }
  }
  function confirmConnection(data) {
    const connected = piConnections(data).find(c => c.id === (flow?.connectionId || `legacy:${flow?.providerId}`) && piProviderConfigured(c));
    if (!connected) {
      setError({message:"登录已结束，但连接状态尚未确认。请重新加载。",code:"invalidResponse"});
      return;
    }
    setError(""); setNotice(connected.name + " 已连接，请选择模型。"); setSection("use");
  }
  const reload = () => act(async () => {
    const data = await refresh(!config);
    if(active) await controller.current?.poll();
    else if(data && flow?.status === "complete") confirmConnection(data);
  });
  const login = method => act(() => controller.current.begin(account?.id||authProvider, method, modern ? authConnectionId : undefined));
  async function closeFlowWindows(id) {
    if (!native || !id) return;
    try { await window.__PIBOT_NATIVE__.call("pi_settings_close_forms", {path:baseUrl + "/pi/login/" + id}); }
    catch { /* Older native clients retain their existing secure-window behavior. */ }
  }
  async function cancelLogin(back = false) {
    const previous = controller.current?.current;
    const wasPending = previous?.status === "pending";
    const cleanup = controller.current?.cancel();
    setValue(""); setError(""); setNotice(wasPending ? "登录已取消。" : "");
    if(back) setSection(modern ? "connections" : "use");
    await cleanup;
    await closeFlowWindows(previous?.id);
  }
  function loginLink(url, label) {
    const href = safeLink(url);
    if (!href) return null;
    return native ? <Button key={url} variant="soft" size="2" disabled={busy}
      onClick={() => void act(async () => {
        const id=flow.id;
        await window.__PIBOT_NATIVE__.call("pi_settings_open_login", {path:baseUrl + "/pi/login/" + id,url});
        if(controller.current?.current?.id===id) setOpenedFlow(id);
      })}>{label}</Button> : <a key={url} href={href} target="_blank" rel="noreferrer" onClick={() => setOpenedFlow(flow.id)}>{label}</a>;
  }
  if (!config)
    return (
      <div className="pi-settings-panel" aria-busy={!error}>
        {error ? (
          <SettingsError error={error} onRetry={reload} busy={busy} />
        ) : (
          <div
            className="pi-settings-loading"
            role="status"
            aria-label="正在读取 Pi 配置"
          >
            <Skeleton height="64px" />
            <Skeleton height="100px" />
            <Skeleton height="64px" />
          </div>
        )}
      </div>
    );
  if (modern && native && !nativeConnections) return <div className="pi-settings-panel"><Text role="status" size="2">此运行环境支持独立模型连接。请更新原生客户端后管理连接；现有账号和模型保持不变。</Text></div>;
  return (
    <div className="pi-settings-panel">
      {section === "connections" ? <ConnectionList connections={connections} providers={config.providers} currentId={currentConnectionId(config)} busy={busy} onBack={()=>setSection("use")}
        onAdd={()=>{setEditing(null);setNotice("");setError("");setSection(modern?"add":"auth");setAuthConnectionId("");setShowMethods(true);}}
        onManage={id=>{setRemoveConfirm(false);const c=connections.find(c=>c.id===id);setAuthConnectionId(id);setAuthProvider(c.providerId);setShowMethods(!c.configured);setNotice("");setError("");setSection("auth");}}/>
      : section === "add" || section === "edit" ? <ConnectionEditor key={editing?.id||"new"} providers={config.providers} connection={editing}
        canCustom={config.connectionManagement?.customEndpoint!==false} apiOptions={config.connectionManagement?.endpointApis} busy={busy}
        onCancel={()=>{setEditing(null);setError("");setSection(connections.length?"connections":"use");}}
        onSave={value=>act(async()=>{const generation=routeEpoch.current;const result=await request("connections/save",value);const data=await refresh();if(!data||generation!==routeEpoch.current)return;
          const saved=piConnections(data).find(c=>c.id===(result.connection?.id||value.id));if(!saved)throw new Error("连接已提交，请刷新确认状态");
          setAuthConnectionId(saved.id);setAuthProvider(saved.providerId);setShowMethods(!saved.configured);setEditing(null);setSection("auth");})}/>
      : section === "auth" ? (
        <section className="pi-mode-content" aria-label="认证管理">
          <div className="pi-field-heading">
            {hasConnection ? <Button variant="ghost" color="gray" size="2" className="settings-back"
              onClick={() => void cancelLogin(true)}><ArrowLeft size={14} />返回</Button> :
              <Text size="3" weight="medium">连接模型</Text>}
            <Text size="1" color="gray">{runtimeLabel}</Text>
          </div>
          <section className="pi-settings-section" aria-label="提供商与认证">
            {!active && !authConnection && <><Text size="2" color="gray">先选择提供商，再完成认证。</Text>
            <Choice label="模型提供商" value={authProvider} disabled={busy || active || confirming} searchable
              items={config.providers.map(p => ({id:p.id,name:p.name,
                detail:[p.methodLabels?.oauth, p.methods.includes("api_key") ? "API key" : ""].filter(Boolean).join(" · ")}))}
              onChange={v => { void controller.current?.cancel(); setAuthProvider(v); setError(""); setNotice(""); }} /></>}
            {account && <>
              {active && <div className="pi-auth-summary"><Text size="2" weight="medium">{account.name}</Text><Text size="1" color="gray">{flow.type === "oauth" ? account.methodLabels?.oauth || "账号登录" : "API key"}</Text></div>}
              {!active && <div className="pi-account-row">
                <div className="pi-account-status">
                  <span className="pi-status-dot" data-connected={!!piProviderConfigured(account)} />
                  <Text size="2" color="gray">{account.catalog?.authChecked === false ? "认证状态暂未确认" : account.credential === "oauth" ? "账号已连接" : account.credential ? "API key 已配置" : piProviderConfigured(account) ? "运行环境已配置认证" : "尚未连接"}</Text>
                </div>
                {account.credential && <DropdownMenu.Root>
                  <DropdownMenu.Trigger><Button aria-label="管理提供商认证" size="1" variant="ghost" color="gray" disabled={busy || active}><MoreHorizontal size={17} /></Button></DropdownMenu.Trigger>
                  <DropdownMenu.Content><DropdownMenu.Item color="red" onSelect={() => void act(async () => {
                    await request("logout", {provider:account.id,...(modern?{connectionId:authConnectionId}:{})}); if (await refresh()) {setShowMethods(true);setNotice("已断开此连接的认证，其他连接保留。");}
                  })}>断开连接</DropdownMenu.Item></DropdownMenu.Content>
                </DropdownMenu.Root>}
              </div>}
              {!active && authConnection && <div className="pi-connected-summary"><span><strong>{authConnection.name}</strong><small>{providerAccount?.name||"自定义服务"}</small></span>
                <Flex gap="2" wrap="wrap">{authConnection.configured&&!showMethods&&<Button size="1" variant="ghost" onClick={()=>setShowMethods(true)}>重新认证</Button>}
                {modern&&!authConnection.legacy&&<Button size="1" variant="ghost" color="gray" onClick={()=>{setEditing(authConnection);setSection("edit");}}>编辑连接</Button>}
                {modern&&!authConnection.legacy&&<Button size="1" variant="ghost" color="gray" disabled={busy} onClick={()=>setRemoveConfirm(true)}>移除连接</Button>}</Flex></div>}
              {removeConfirm&&!active&&<div className="pi-remove-confirm" role="group" aria-label="确认移除连接"><Text size="2">移除“{authConnection.name}”的连接记录？历史会话和本地凭据文件保留；不会自动选择其他账号。</Text><Flex gap="2"><Button size="1" color="red" disabled={busy} onClick={()=>void act(async()=>{await request("connections/remove",{connectionId:authConnectionId,expectedRevision:authConnection.revision});await refresh();setRemoveConfirm(false);setAuthConnectionId("");setSection("connections");})}>确认移除</Button><Button size="1" variant="soft" disabled={busy} onClick={()=>setRemoveConfirm(false)}>取消</Button></Flex></div>}
              {!active && !confirming && (!authConnection?.configured || showMethods) && <div className="pi-account-actions pi-auth-methods">
                {[...account.methods].sort((a,b) => (a === "oauth" ? 0 : 1) - (b === "oauth" ? 0 : 1)).map(method => <Button
                  key={method} variant={method === "oauth" ? "solid" : "soft"} size="2" disabled={busy}
                  onClick={() => void login(method)}>
                  {method === "oauth" ? <LogIn size={15} /> : <KeyRound size={15} />}
                  {method === "oauth" ? (account.methodLabels?.oauth || "登录账号") : (account.credential === "api_key" ? "更新 API key" : "添加 API key")}
                </Button>)}
              </div>}
            </>}
          </section>
          {active && <div className="pi-login-flow" aria-busy={!!flow.starting || !!flow.submitting}>
            <div className="pi-login-status" role="status">
              {presentation.spinning && <LoaderCircle size={15} className="pi-spinner" aria-hidden="true"/>}
              <Text size="2" weight="medium">{presentation.title}</Text>
            </div>
            {presentation.note && <Text size="1" color="gray">{presentation.note}</Text>}
            {(flow.events || []).map((event,i) => <React.Fragment key={i}>
              {event.message && !(presentation.browser && event.type === "progress") && <Text size="2">{event.message}</Text>}
              {event.instructions && !(presentation.browser && event.type === "auth_url") && <Text size="2">{event.instructions}</Text>}
              {event.userCode && <Text size="4" weight="bold" className="pi-device-code">{event.userCode}</Text>}
              {!presentation.exchanging && loginLink(event.url || event.verificationUri, openedFlow === flow.id ? "重新打开授权页面" : "打开授权页面")}
              {event.links?.map(l => loginLink(l.url, l.label || "登录说明"))}
            </React.Fragment>)}
            {flow.prompt && !presentation.exchanging && (presentation.fallback ? <details className="pi-login-fallback" key={flow.prompt.id}>
              <summary>无法自动完成？</summary>
              <Text as="p" size="1" color="gray">仅在授权后未自动返回时，使用浏览器最后显示的完整授权回跳地址。它包含一次性授权信息，请勿发送到聊天。</Text>
              {native ? <Button type="button" disabled={busy} onClick={() => void act(() => window.__PIBOT_NATIVE__.call("pi_settings_credential_window", {
                path:baseUrl + "/pi/login/" + flow.id,promptId:flow.prompt.id,
              }))}>粘贴授权回跳地址</Button> : <form onSubmit={e => {
                e.preventDefault(); const entered=value; setValue(""); void act(() => controller.current.answer(flow.prompt.id,entered));
              }}><Flex direction="column" gap="3">
                <TextField.Root aria-label="授权回跳地址" type="password" autoComplete="off" placeholder="完整授权回跳地址"
                  value={value} disabled={busy || flow.submitting} onChange={e => setValue(e.target.value)}/>
                <Button type="submit" disabled={busy || flow.submitting || !value.trim()}>提交备用回跳地址</Button>
              </Flex></form>}
            </details> : <form onSubmit={e => {
              e.preventDefault(); const entered = value; setValue("");
              void act(() => controller.current.answer(flow.prompt.id, entered));
            }}><Flex direction="column" gap="3">
              <Text size="2">{flow.prompt.message}</Text>
              {native && flow.prompt.type !== "select" ? <Button type="button" disabled={busy || flow.submitting}
                onClick={() => void act(() => window.__PIBOT_NATIVE__.call("pi_settings_credential_window", {
                  path:baseUrl + "/pi/login/" + flow.id, promptId:flow.prompt.id,
                }))}><KeyRound size={15} />打开安全输入窗口</Button> : <>
                {flow.prompt.type === "select" ? <Choice label="登录选项" value={value} onChange={setValue}
                  disabled={busy || flow.submitting} items={flow.prompt.options.map(o => ({id:o.id,name:account?.id === "openai-codex" && o.id === "device_code" ? "设备码登录（可在手机授权）" : account?.id === "openai-codex" && o.id === "browser" ? "浏览器登录" : o.label}))} /> :
                  <TextField.Root aria-label="Pi 登录输入" type={flow.prompt.type === "secret" ? "password" : "text"}
                    autoComplete="off" placeholder={flow.prompt.placeholder || "输入后提交"} value={value}
                    disabled={busy || flow.submitting} onChange={e => setValue(e.target.value)} />}
                <Button type="submit" disabled={busy || flow.submitting || !value.trim()}>继续</Button>
              </>}
            </Flex></form>)}
            <Button variant="ghost" color="gray" onClick={() => void cancelLogin()}>取消登录</Button>
          </div>}
          {confirming && !error && <div className="pi-login-status" role="status"><LoaderCircle size={15} className="pi-spinner" aria-hidden="true"/><Text size="2">正在核对认证和模型目录…</Text></div>}
        </section>
      ) : (
        <section className="pi-mode-content" aria-label="模型使用">
          <section className="pi-settings-section pi-model-section" aria-label="默认模型设置">
            <div className="pi-field-heading">
              <div><Text as="p" size="3" weight="medium">{configured ? "默认模型" : "选择默认模型"}</Text><Text as="p" size="1" color="gray">{runtimeLabel}</Text></div>
              <Button size="1" variant="ghost" color="gray" className="pi-auth-entry" onClick={() => {setNotice("");setError("");setSection(hasConnection?"connections":modern?"add":"auth");}}>
                <KeyRound size={13} />{hasConnection ? "管理连接" : "连接提供商"}<ChevronRight size={13} />
              </Button>
            </div>
            <Choice label="默认模型" value={validModel ? JSON.stringify([connectionId,model]) : ""}
              fallback={config.current.connectionUnavailable ? "原连接已不可用，请选择其他连接的模型" : models.length ? "请选择模型" : visibleCatalog?.status === "failed" ? "模型目录暂未确认" : "尚无模型目录"}
              onChange={id => {const option=models.find(m => m.id===id); if(option){setProvider(option.provider);setConnectionId(option.connectionId);setModel(option.model);setNotice("");}}}
              disabled={busy || !models.length} searchable items={models} />
            <details className="pi-catalog-details"><summary>{visibleCatalog?.accountAccess==="confirmed"?"账号模型目录已更新":visibleCatalog?.status==="failed"?"模型目录暂未确认":"模型目录"}{visibleCatalog?.unsupportedModelCount ? ` · ${visibleCatalog.unsupportedModelCount} 个型号暂不支持` : ""}</summary><Text as="p" size="1" color="gray" className="pi-catalog-note">{piCatalogNote(visibleCatalog)}</Text></details>
            {!models.length && <Text size="2" color="gray">{visibleCatalog?.status === "failed" ? "暂时无法确认认证或模型目录，请重新检查。" : hasConnection ? "已连接的提供商暂未返回模型目录。" : "连接提供商后，即可选择模型。"}</Text>}
            {visibleCatalog && ["failed","partial"].includes(visibleCatalog.status) && <Button variant="ghost" color="gray" size="1" disabled={busy} onClick={reload}><RefreshCw size={13}/>重新检查模型目录</Button>}
            {validModel && selectedModel.reasoning && <details className="pi-advanced"><summary>更多选项</summary><div className="pi-thinking-row">
              <div><Text as="p" size="2" weight="medium">思考强度</Text><Text as="p" size="1" color="gray">更深入的推理可能需要更长时间</Text></div>
              <Choice label="思考强度" value={thinkingSelection.value} onChange={setThinking}
                disabled={busy || !thinkingSelection.known || !thinkingSelection.items.length} items={thinkingSelection.items} />
            </div></details>}
            {validModel && thinkingSelection.note && <Text as="p" size="1" color="gray" role="status">{thinkingSelection.note}</Text>}
          </section>
          {validModel && <div className="pi-settings-footer">
            <Text size="1" color="gray" role="status">{config.reloadPending ? "已保存，等待当前任务完成后应用" : !configured ? "确认后即可开始聊天" : dirty ? "有未保存的更改" : "已保存"}</Text>
            <Button size="2" disabled={busy || !dirty || !thinkingSelection.valid} onClick={() => void act(async () => {
              const result=await request("model",{provider,model,thinkingLevel:thinkingSelection.saveLevel,...(modern?{connectionId}:{})});
              const saved=await refresh(); if (!saved) return;
              setThinking(saved.current.thinkingLevel);
              setNotice(result.pending ? "已保存，当前任务完成后自动应用。" : "模型已保存。");
              if (!configured && !result.pending) onConfigured?.();
            })}>{busy ? <LoaderCircle size={14} className="pi-spinner" /> : <Check size={14} />}{configured ? "保存更改" : "完成设置"}</Button>
          </div>}
        </section>
      )}
      {notice && <Text size="2" color="gray" role="status">{notice}</Text>}
      {effectiveError && <SettingsError error={effectiveError} onRetry={reload} busy={busy} />}
    </div>
  );
}
