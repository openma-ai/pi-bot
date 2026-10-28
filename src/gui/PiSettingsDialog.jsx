import React, { useEffect, useState, useRef, useMemo } from "react";
import {
  Flex,
  Text,
  TextField,
  Button,
  Select,
  Popover,
  Skeleton,
} from "@radix-ui/themes";
import { Command } from "cmdk";
import {
  Check,
  ChevronDown,
  Search,
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
function Choice({
  label,
  value,
  onChange,
  items,
  disabled,
  searchable = false,
  fallback,
}) {
  const [open, setOpen] = useState(false);
  if (!searchable)
    return (
      <Select.Root
        value={value || ""}
        onValueChange={onChange}
        disabled={disabled}
      >
        <Select.Trigger aria-label={label} placeholder="请选择" />
        <Select.Content
          position="popper"
          sideOffset={6}
          align="end"
          variant="soft"
          className="pi-select-menu"
        >
          {items.map((i) => (
            <Select.Item key={i.id} value={i.id}>
              {i.name}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
    );
  const selected = items.find((i) => i.id === value);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <button
          type="button"
          className="pi-choice"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          disabled={disabled}
        >
          <span>
            <span className="pi-choice-name">
              {selected?.name || fallback || value || "请选择"}
            </span>
            {selected?.detail && (
              <span className="pi-choice-detail">{selected.detail}</span>
            )}
          </span>
          <ChevronDown size={15} />
        </button>
      </Popover.Trigger>
      <Popover.Content
        className="pi-choice-popover"
        side="bottom"
        align="start"
        size="1"
      >
        <Command
          label={"搜索" + label}
          defaultValue={
            selected ? selected.id + " " + selected.name : undefined
          }
        >
          <div className="pi-choice-search">
            <Search size={15} />
            <Command.Input
              placeholder={"搜索" + label}
              aria-label={"搜索" + label}
            />
          </div>
          <Command.List>
            <Command.Empty>没有匹配的选项</Command.Empty>
            {items.map((i) => (
              <Command.Item
                key={i.id}
                value={i.id + " " + i.name + " " + (i.detail || "")}
                onSelect={() => {
                  onChange(i.id);
                  setOpen(false);
                }}
              >
                <span className="pi-choice-option">
                  <span>{i.name}</span>
                  {i.detail && <small>{i.detail}</small>}
                </span>
                {i.id === value && <Check size={15} />}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </Popover.Content>
    </Popover.Root>
  );
}
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
      setModel(data.current.model || "");
      setThinking(data.current.thinkingLevel || "high");
      setAuthProvider(data.current.provider || data.providers.find(p => piProviderConfigured(p))?.id ||
        data.providers.find(p => p.id === "openai")?.id || data.providers[0]?.id || "");
      setSection(data.providers.some(p => piProviderConfigured(p) || p.credential) ? "use" : "auth");
    }
    return data;
  }
  useEffect(() => {
    alive.current = true; scope.current++;
    setConfig(undefined); setFlow(undefined); setError(""); setNotice("");
    const version = scope.current;
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
  const account = config?.providers.find(p => p.id === authProvider);
  const models = (config?.providers || []).filter(p => piProviderConfigured(p)).flatMap(p =>
    p.models.map(m => ({ id: JSON.stringify([p.id, m.id]), name: m.name,
      detail: p.name + " · " + m.id, provider: p.id, model: m.id })));
  const selected = config?.providers.find(p => p.id === provider);
  const visibleCatalog = selected?.catalog || config?.providers.find(p => piProviderConfigured(p) || p.credential)?.catalog || config?.catalog;
  const selectedModel = selected?.models.find(m => m.id === model);
  const thinkingSelection = piThinkingSelection(selectedModel, thinking);
  const validModel = piProviderConfigured(selected) && !!selectedModel;
  const active = flow?.status === "pending";
  const presentation = piLoginPresentation(flow, callbackPlacement);
  const confirming = flow?.status === "complete" && section === "auth";
  const hasConnection = !!config?.providers.some(p => piProviderConfigured(p) || p.credential);
  const configured = !!config?.providers.some(p => piProviderConfigured(p) && p.id === config.current.provider && p.models.some(m => m.id === config.current.model));
  const dirty = !!config && validModel && (provider !== config.current.provider ||
    model !== config.current.model || thinking !== config.current.thinkingLevel);
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
    const connected = data?.providers.find(p => p.id === flow?.providerId && piProviderConfigured(p));
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
  const login = method => act(() => controller.current.begin(authProvider, method));
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
    if(back) setSection("use");
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
  return (
    <div className="pi-settings-panel">
      {section === "auth" ? (
        <section className="pi-mode-content" aria-label="认证管理">
          <div className="pi-field-heading">
            {hasConnection ? <Button variant="ghost" color="gray" size="2" className="settings-back"
              onClick={() => void cancelLogin(true)}><ArrowLeft size={14} />返回</Button> :
              <Text size="3" weight="medium">连接模型</Text>}
            <Text size="1" color="gray">{runtimeLabel}</Text>
          </div>
          <section className="pi-settings-section" aria-label="提供商与认证">
            {!active && <><Text size="2" color="gray">{hasConnection ? "管理已连接账号，或添加其他提供商。" : "先连接账号，再选择模型。"}</Text>
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
                    await request("logout", {provider:authProvider}); if (await refresh()) setNotice("已断开该提供商的认证。");
                  })}>断开连接</DropdownMenu.Item></DropdownMenu.Content>
                </DropdownMenu.Root>}
              </div>}
              {!active && !confirming && <div className="pi-account-actions pi-auth-methods">
                {[...account.methods].sort((a,b) => (a === "oauth" ? 0 : 1) - (b === "oauth" ? 0 : 1)).map(method => <Button
                  key={method} variant={method === "oauth" ? "solid" : "soft"} size="2" disabled={busy}
                  onClick={() => void login(method)}>
                  {method === "oauth" ? <LogIn size={15} /> : <KeyRound size={15} />}
                  {method === "oauth" ? (account.methodLabels?.oauth || "登录账号") : (account.credential === "api_key" ? "更新 API key" : "添加 API key")}
                </Button>)}
              </div>}
              {!active && !confirming && account.id === "openai" && account.methods.includes("oauth") && <Text as="p" size="1" color="gray" className="pi-auth-note">ChatGPT 账号登录与 OpenAI API key 是两种独立的连接方式。</Text>}
              {!active && !confirming && account.id === "openai" && config.providers.some(p => p.id === "openai-codex" && p.methods.includes("oauth")) &&
                <Button className="pi-device-method" size="1" variant="ghost" color="gray" onClick={() => {
                  void controller.current?.cancel(); setAuthProvider("openai-codex"); setError(""); setNotice("设备码由 OpenAI Codex (legacy) 提供。点击登录后选择设备码，不会更改当前模型或已有连接。");
                }}>设备码登录（可在手机完成）<ChevronRight size={13}/></Button>}
              {!active && !confirming && account.id === "openai-codex" && account.methods.includes("oauth") && <Text as="p" size="1" color="gray" className="pi-auth-note">此 SDK 提供商支持浏览器登录或设备码登录；设备码可在手机上授权。</Text>}
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
              <Button size="1" variant="ghost" color="gray" className="pi-auth-entry" onClick={() => {setNotice("");setSection("auth");}}>
                <KeyRound size={13} />{hasConnection ? "管理连接" : "连接提供商"}<ChevronRight size={13} />
              </Button>
            </div>
            <Choice label="默认模型" value={validModel ? JSON.stringify([provider,model]) : ""}
              fallback={models.length ? "请选择模型" : visibleCatalog?.status === "failed" ? "模型目录暂未确认" : "尚无模型目录"}
              onChange={id => {const option=models.find(m => m.id===id); if(option){setProvider(option.provider);setModel(option.model);setNotice("");}}}
              disabled={busy || !models.length} searchable items={models} />
            <Text as="p" size="1" color="gray" className="pi-catalog-note">{piCatalogNote(visibleCatalog)}</Text>
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
              const result=await request("model",{provider,model,thinkingLevel:thinkingSelection.saveLevel});
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
