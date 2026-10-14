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
        value={value || undefined}
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
                value={i.id + " " + i.name}
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
export function PiSettingsPanel({ baseUrl = "", registerBeforeSwitch }) {
  const open = true;
  const request = useMemo(() => createPiSettingsClient(baseUrl), [baseUrl]);
  const flowRef = useRef();
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
    [notice, setNotice] = useState("");
  const alive = useRef(false);
  async function refresh(initial = false) {
    const data = await request("config");
    if (!alive.current) return;
    setConfig(data);
    if (initial) {
      setProvider(
        data.current.provider ||
          data.providers.find((p) => p.credential)?.id ||
          data.providers.find((p) => p.id === "deepseek")?.id ||
          data.providers[0]?.id ||
          "",
      );
      setAuthProvider(
        data.current.provider ||
          data.providers.find((p) => p.credential)?.id ||
          data.providers[0]?.id ||
          "",
      );
      setSection("use");
      setModel(data.current.model);
      setThinking(data.current.thinkingLevel);
    }
    return data;
  }
  useEffect(() => {
    alive.current = open;
    if (open) {
      setError("");
      setNotice("");
      void refresh(true).catch((e) => setError(e));
    }
    return () => {
      alive.current = false;
    };
  }, [open, request]);
  useEffect(() => {
    flowRef.current = flow;
  }, [flow]);
  useEffect(
    () => () => {
      const pending = flowRef.current;
      if (pending?.status === "pending")
        void request("login/" + pending.id + "/cancel", {}).catch(() => {});
    },
    [request],
  );
  useEffect(() => {
    if (!open || flow?.status !== "pending") return;
    let stopped = false,
      inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await request("login/" + flow.id);
        if (stopped) return;
        setFlow(next);
        if (next.prompt?.id !== flow.prompt?.id) setValue("");
        if (next.status === "complete") {
          setValue("");
          await refresh();
          setError("");
          setNotice("Pi 登录已保存，可以选择模型。");
        }
        if (next.status === "failed")
          setError({ message: next.error || "Pi 登录未完成，请重试" });
      } catch (e) {
        if (!stopped) setError(e);
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 600);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [open, flow?.id, flow?.status, flow?.prompt?.id]);
  useEffect(
    () =>
      registerBeforeSwitch?.(async () => {
        const pending = flowRef.current;
        if (pending?.status === "pending")
          await request("login/" + pending.id + "/cancel", {});
        setValue("");
        setFlow(undefined);
      }),
    [registerBeforeSwitch, request],
  );
  const account = config?.providers.find((p) => p.id === authProvider);
  const models = (config?.providers || [])
    .filter((p) => p.credential)
    .flatMap((p) =>
      p.models.map((m) => ({
        id: JSON.stringify([p.id, m.id]),
        name: m.name,
        detail: p.name + " · " + m.id,
        provider: p.id,
        model: m.id,
      })),
    );
  const selected = config?.providers.find((p) => p.id === provider);
  const selectedModel = selected?.models.find((m) => m.id === model);
  const active = flow?.status === "pending";
  async function act(fn) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const dirty =
    !!config &&
    (provider !== config.current.provider ||
      model !== config.current.model ||
      thinking !== config.current.thinkingLevel);
  const reload = () => act(() => refresh(!config));
  async function login(method) {
    await act(async () => {
      const { id } = await request("login", {
        provider: authProvider,
        type: method,
      });
      setFlow({ id, status: "pending" });
      setValue("");
    });
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
      {section === "auth" && (
        <section className="pi-mode-content" aria-label="认证管理">
          <Button
            variant="ghost"
            color="gray"
            size="2"
            className="settings-back"
            disabled={busy}
            onClick={() => {
              if (!active) {
                setSection("use");
                return;
              }
              void act(async () => {
                await request("login/" + flow.id + "/cancel", {});
                setFlow(undefined);
                setValue("");
                setSection("use");
              });
            }}
          >
            <ArrowLeft size={14} />
            模型设置
          </Button>
          <Text as="p" size="2" color="gray" className="pi-mode-description">
            管理提供商账号与凭据。
          </Text>
          <section className="pi-settings-section" aria-label="提供商与认证">
            <div className="pi-field-heading">
              <Text size="2" weight="medium">
                模型提供商
              </Text>
            </div>
            <Choice
              label="模型提供商"
              value={authProvider}
              disabled={busy || active}
              searchable
              items={config.providers.map((p) => ({ id: p.id, name: p.name }))}
              onChange={(v) => {
                setAuthProvider(v);
                setFlow(undefined);
                setError("");
                setNotice("");
              }}
            />
            {account && (
              <div className="pi-account-row">
                <div className="pi-account-status">
                  <span
                    className="pi-status-dot"
                    data-connected={!!account.credential}
                  />
                  <Text size="2" color="gray">
                    {account.credential
                      ? account.credential === "oauth"
                        ? "账号已连接"
                        : "API key 已配置"
                      : "尚未连接"}
                  </Text>
                </div>
                <div className="pi-account-actions">
                  {account.methods.map((method) => (
                    <Button
                      key={method}
                      variant="soft"
                      color="gray"
                      size="1"
                      disabled={busy || active}
                      onClick={() => void login(method)}
                    >
                      {method === "oauth" ? (
                        <LogIn size={13} />
                      ) : (
                        <KeyRound size={13} />
                      )}
                      {method === "oauth"
                        ? account.credential
                          ? "重新登录"
                          : "登录账号"
                        : account.credential
                          ? "更新 key"
                          : "添加 API key"}
                    </Button>
                  ))}
                  {account.credential && (
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger>
                        <Button
                          aria-label="管理提供商认证"
                          size="1"
                          variant="ghost"
                          color="gray"
                          disabled={busy || active}
                        >
                          <MoreHorizontal size={17} />
                        </Button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content>
                        <DropdownMenu.Item
                          color="red"
                          onSelect={() =>
                            void act(async () => {
                              await request("logout", {
                                provider: authProvider,
                              });
                              await refresh();
                              setNotice("已断开该提供商的认证。");
                            })
                          }
                        >
                          断开连接
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Root>
                  )}
                </div>
              </div>
            )}
          </section>
          {active && (
            <div className="pi-login-flow">
              <Text size="2">
                正在连接 {account?.name || flow.providerId || authProvider}
              </Text>
              {(flow.events || []).map((event, i) => (
                <React.Fragment key={i}>
                  {event.message && <Text size="2">{event.message}</Text>}
                  {event.instructions && (
                    <Text size="2">{event.instructions}</Text>
                  )}
                  {event.userCode && (
                    <Text size="3" weight="bold">
                      {event.userCode}
                    </Text>
                  )}
                  {safeLink(event.url || event.verificationUri) && (
                    <a
                      href={safeLink(event.url || event.verificationUri)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      打开 Pi 登录页面
                    </a>
                  )}
                  {event.links
                    ?.filter((l) => safeLink(l.url))
                    .map((l) => (
                      <a
                        key={l.url}
                        href={safeLink(l.url)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {l.label || "登录说明"}
                      </a>
                    ))}
                </React.Fragment>
              ))}
              {flow.prompt && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const entered = value;
                    setValue("");
                    void act(async () => {
                      await request("login/" + flow.id + "/input", {
                        promptId: flow.prompt.id,
                        value: entered,
                      });
                    });
                  }}
                >
                  <Flex direction="column" gap="3">
                    <Text size="2">{flow.prompt.message}</Text>
                    {flow.prompt.type === "select" ? (
                      <Choice
                        label="登录选项"
                        value={value}
                        onChange={setValue}
                        items={flow.prompt.options.map((o) => ({
                          id: o.id,
                          name: o.label,
                        }))}
                      />
                    ) : (
                      <TextField.Root
                        aria-label="Pi 登录输入"
                        type={
                          flow.prompt.type === "secret" ? "password" : "text"
                        }
                        autoComplete="off"
                        placeholder={
                          flow.prompt.placeholder || "输入后提交给 Pi"
                        }
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                      />
                    )}
                    <Button type="submit" disabled={busy || !value.trim()}>
                      提交
                    </Button>
                  </Flex>
                </form>
              )}
              <Button
                variant="ghost"
                onClick={() =>
                  act(async () => {
                    await request("login/" + flow.id + "/cancel", {});
                    setValue("");
                    setFlow(undefined);
                  })
                }
              >
                取消登录
              </Button>
            </div>
          )}
          {notice && (
            <Text size="2" color="gray" role="status">
              {notice}
            </Text>
          )}
        </section>
      )}
      {section === "use" && (
        <section className="pi-mode-content" aria-label="模型使用">
          {!active && (
            <section
              className="pi-settings-section pi-model-section"
              aria-label="默认模型设置"
            >
              <div className="pi-field-heading">
                <Text size="2" weight="medium">
                  默认模型
                </Text>
                <Button
                  size="1"
                  variant="ghost"
                  color="gray"
                  className="pi-auth-entry"
                  onClick={() => {
                    setNotice("");
                    setSection("auth");
                  }}
                >
                  <KeyRound size={13} />
                  管理认证
                  <ChevronRight size={13} />
                </Button>
              </div>
              <Choice
                label="默认模型"
                value={JSON.stringify([provider, model])}
                fallback={selectedModel?.name || model || "请选择模型"}
                onChange={(id) => {
                  const option = models.find((m) => m.id === id);
                  if (option) {
                    setProvider(option.provider);
                    setModel(option.model);
                    setNotice("");
                  }
                }}
                disabled={busy || !models.length}
                searchable
                items={models}
              />
              {!models.length && (
                <Text size="2" color="gray">
                  还没有已认证的模型。
                  <Button
                    size="1"
                    variant="ghost"
                    onClick={() => setSection("auth")}
                  >
                    连接提供商
                  </Button>
                </Text>
              )}
              <div className="pi-thinking-row">
                <div>
                  <Text as="p" size="2" weight="medium">
                    思考强度
                  </Text>
                  <Text as="p" size="1" color="gray">
                    更深入的推理可能需要更长时间
                  </Text>
                </div>
                <Choice
                  label="思考强度"
                  value={thinking}
                  onChange={setThinking}
                  disabled={busy}
                  items={[
                    ["off", "关闭"],
                    ["minimal", "最低"],
                    ["low", "低"],
                    ["medium", "标准"],
                    ["high", "高"],
                    ["xhigh", "更高"],
                    ["max", "最高"],
                  ].map(([id, name]) => ({ id, name }))}
                />
              </div>
            </section>
          )}
          {!active && (
            <div className="pi-settings-footer">
              <Text size="1" color="gray" role="status">
                {notice ||
                  (config.reloadPending
                    ? "已保存，等待当前任务完成后应用"
                    : dirty
                      ? "有未保存的更改"
                      : "已保存")}
              </Text>
              <Button
                size="2"
                disabled={
                  busy || !provider || !model || !dirty || !selected?.credential
                }
                onClick={() =>
                  void act(async () => {
                    const result = await request("model", {
                      provider,
                      model,
                      thinkingLevel: thinking,
                    });
                    await refresh();
                    setNotice(
                      result.pending
                        ? "已保存，当前任务完成后自动应用。"
                        : "模型已保存。",
                    );
                  })
                }
              >
                {busy ? (
                  <LoaderCircle size={14} className="pi-spinner" />
                ) : (
                  <Check size={14} />
                )}
                保存更改
              </Button>
            </div>
          )}
        </section>
      )}
      {error && <SettingsError error={error} onRetry={reload} busy={busy} />}
    </div>
  );
}
