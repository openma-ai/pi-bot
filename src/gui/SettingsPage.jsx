import {PiboMark} from './PiboBrand.jsx';
import { DirectConnect } from './DirectConnect.jsx';
import { TailnetConnect } from './TailnetConnect.jsx';
import React, { useEffect, useRef, useState } from "react";
import {
  Dialog,
  Tabs,
  Flex,
  Text,
  Heading,
  TextField,
  Button,
  Badge,
  ScrollArea,
  Card,
  DropdownMenu,
} from "@radix-ui/themes";
import {
  Laptop,
  Cloud,
  X,
  Plus,
  Check,
  ChevronDown,
  MoreHorizontal,
  ArrowLeft,
} from "lucide-react";
import { PiSettingsPanel } from "./PiSettingsDialog.jsx";
const kindLabel = (profile) => (["local", "builtin"].includes(profile.mode) ? "Local" : "Cloud");
function RuntimeIcon({ profile, size = 20 }) {
  return !["local", "builtin"].includes(profile?.mode) ? (
    <Cloud size={size} />
  ) : (
    <Laptop size={size} />
  );
}
export function RuntimePicker({ runtime }) {
  const { status, busy, connect } = runtime,
    profiles = status.profiles?.filter(p=>p.mode!=="ssh");
  if (!profiles || profiles.length < 2) return null;
  const active =
    profiles.find((p) => p.id === status.active?.profileId) ||
    status.active?.profile;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Button
          variant="ghost"
          color="gray"
          className="runtime-switcher"
          aria-label="切换 runtime"
          disabled={busy}
        >
          <RuntimeIcon profile={active} size={15} />
          <span>{active?.name || "选择 runtime"}</span>
          <ChevronDown size={14} />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        {profiles.map((p) => (
          <DropdownMenu.Item
            key={p.id}
            onSelect={() => void connect(p).catch(() => {})}
          >
            <RuntimeIcon profile={p} size={15} />
            {p.name}
            <Badge color="gray" size="1">
              {kindLabel(p)}
            </Badge>
            {p.id === status.active?.profileId && <Check size={14} />}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
function Field({ label, value, onChange, placeholder, type = "text" }) {
  return (
    <label className="setting-field">
      <Text size="2" weight="medium">
        {label}
      </Text>
      <TextField.Root
        aria-label={label}
        type={type}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function RuntimeSettings({ runtime, menuContainer }) {
  const { profiles, active } = runtime.status;
  const [editor, setEditor] = useState(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [enabling, setEnabling] = useState("");
  async function enable(profile) {
    setError("");
    setNotice("");
    setEnabling(profile.id);
    try {
      await runtime.connect(profile);
      setNotice("已连接 " + profile.name + "。");
    } catch (e) {
      setError(e.message);
    } finally {
      setEnabling("");
    }
  }
  async function save(profile) {
    await runtime.configure(profile);
    setEditor(undefined);
    setNotice("连接已保存，点击连接后使用。");
    setError("");
  }
  async function remove(profile) {
    setError("");
    try {
      await runtime.remove(profile.id);
      setNotice("已移除连接，server 上的数据和任务保留。");
    } catch (e) {
      setError(e.message);
    }
  }
  if (editor)
    return (
      <div className="settings-pane">
        <RuntimeEditor
          key={editor.id || "new"}
          profile={editor.id ? editor : undefined}
          tailState={runtime.status.tailscaleNodeState}
          tailscaleAvailable={!!runtime.status.embeddedTailscaleAvailable}
          remoteOnly={!!runtime.status.remoteOnly}
          sessionOnly={runtime.status.credentialStorage === "session"}
          onSave={save}
          onCancel={() => setEditor(undefined)}
        />
      </div>
    );
  return (
    <div className="settings-pane">
      {runtime.busy && <Button color="gray" variant="soft" onClick={()=>void runtime.cancelConnect().catch(e=>setError(e.message))}>取消连接</Button>}
      <div className="settings-pane-heading">
        <Flex justify="between" align="center" gap="3">
          <Heading size="4">工作空间</Heading>
          {runtime.managed && (
            <Button
              size="2"
              variant="soft"
              color="gray"
              disabled={runtime.busy || !profiles}
              onClick={() => {
                setEditor({});
                setError("");
                setNotice("");
              }}
            >
              <Plus size={15} />
              添加连接
            </Button>
          )}
        </Flex>
        <Text as="p" size="2" color="gray">
          {runtime.status.builtinHarness?.supported ? "在本机运行，或连接远端工作空间。" : "连接已运行的 Pibo 服务。"}
        </Text>
      </div>
      <div className="runtime-cards" role="list" aria-label="工作空间连接">
        {(
          profiles || (runtime.managed ? [] : [{ id: "direct", name: "当前 server", mode: "local" }])
        ).map((profile) => {
          const enabled =
              active?.profileId === profile.id ||
              (profile.id === "direct" && !!active),
            local = profile.mode === "local", builtin = profile.mode === "builtin";
          return (
            <div
              role="listitem"
              key={profile.id}
              className="runtime-card"
              data-active={enabled}
            >
              <div className="runtime-card-header">
                <div className="runtime-card-icon">
                  <RuntimeIcon profile={profile} size={24} />
                </div>
                {runtime.managed && (
                  // Keep this menu inside the Settings modal's DOM/focus scope
                  // so iOS exposes both menu items and the restored dialog.
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger>
                      <Button
                        size="1"
                        variant="ghost"
                        color="gray"
                        aria-label={"管理 " + profile.name}
                        disabled={runtime.busy}
                      >
                        <MoreHorizontal size={18} />
                      </Button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content container={menuContainer}>
                      {!builtin && <DropdownMenu.Item
                        onSelect={() => {
                          setEditor(profile);
                          setError("");
                          setNotice("");
                        }}
                      >
                        编辑
                      </DropdownMenu.Item>}
                      <DropdownMenu.Item disabled={profile.mode==="ssh"} onSelect={() => void enable(profile)}>
                        重新连接
                      </DropdownMenu.Item>
                      {enabled && <DropdownMenu.Item onSelect={() => void runtime.disconnect().catch(e => setError(e.message))}>断开连接</DropdownMenu.Item>}
                      {builtin && runtime.status.builtinHarness?.state === "running" && <DropdownMenu.Item onSelect={() => void runtime.stopBuiltin().catch(e => setError(e.message))}>停止本机运行</DropdownMenu.Item>}
                      {!builtin && <><DropdownMenu.Separator />
                      <DropdownMenu.Item
                        color="red"
                        disabled={enabled || ((profiles?.length || 0) < 2 && !runtime.status.remoteOnly)}
                        onSelect={() => void remove(profile)}
                      >
                        移除连接
                      </DropdownMenu.Item></>}
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                )}
              </div>
              <div className="runtime-card-copy">
                <Text size="3" weight="medium">
                  {profile.name}
                </Text>
                <Text size="1" color="gray">
                  {builtin ? (runtime.status.builtinHarness?.state === "running" ? "内置运行 · 已启动" : runtime.status.builtinHarness?.available ? "内置运行 · 连接时启动" : "内置运行组件不可用") : profile.mode === "ssh" ? "旧 SSH 配置 · 请新建连接迁移" : profile.mode === "direct" ? profile.url : !local ? profile.host : "独立本机服务 · 需先启动"}
                </Text>
              </div>
              <div className="runtime-card-footer">
                {enabled ? (
                  <Text size="1" className="runtime-enabled">
                    <Check size={13} />
                    当前连接
                  </Text>
                ) : (
                  <Button
                    size="1"
                    variant="soft"
                    disabled={runtime.busy || !runtime.managed || profile.mode === "ssh" || (builtin && !runtime.status.builtinHarness?.available)}
                    onClick={() => void enable(profile)}
                  >
                    {profile.mode === "ssh" ? "需要迁移" : enabling === profile.id ? "连接中…" : builtin && runtime.status.builtinHarness?.state !== "running" ? "启动并连接" : "连接"}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <Text as="p" size="1" color="gray" className="settings-note">
        切换连接不会停止其他工作空间的任务。
      </Text>
      {runtime.status.builtinHarness?.error && runtime.status.builtinHarness.error !== (error || runtime.error) && <Text as="p" size="2" role="status" color="gray">{runtime.status.builtinHarness.error}</Text>}
      {notice && (
        <Text as="p" size="2" color="green" role="status">
          {notice}
        </Text>
      )}
      {(error || runtime.error) && (
        <div className="connection-error" role="alert">
          <Text size="2">{error || runtime.error}</Text>
          <Button
            size="1"
            variant="ghost"
            color="gray"
            onClick={() => {
              setError("");
              runtime.clearError();
            }}
          >
            关闭提醒
          </Button>
        </div>
      )}
      {!runtime.managed && (
        <Text as="p" size="2" color="gray">
          使用 client 启动方式后，可添加和切换 runtime。
        </Text>
      )}
    </div>
  );
}
export function SettingsPage({ open, onOpenChange, runtime, initialTab }) {
  const active = runtime.status.active;
  const [menuContainer, setMenuContainer] = useState(null);
  const [settingsTab, setSettingsTab] = useState(initialTab || (active ? "pi" : "runtime"));
  useEffect(() => {
    if (open) setSettingsTab(initialTab || (active ? "pi" : "runtime"));
  }, [open, initialTab, active?.id]);
  const closeTouch = useRef(null);
  // Native WKWebView can deliver a complete touch without synthesizing click
  // after landscape keyboard dismissal. Keep Dialog.Close for keyboard/AT,
  // and handle only a stationary, primary iOS touch on this close control.
  const startCloseTouch = (event) => {
    closeTouch.current = document.documentElement.dataset.nativeIos === "true" &&
      event.pointerType === "touch" && event.isPrimary
      ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
  };
  const moveCloseTouch = (event) => {
    const start = closeTouch.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8)
      closeTouch.current = null;
  };
  const finishCloseTouch = (event) => {
    const start = closeTouch.current;
    closeTouch.current = null;
    if (start?.id === event.pointerId &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 8 &&
      event.currentTarget.contains(document.elementFromPoint(event.clientX, event.clientY)))
      onOpenChange(false);
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content ref={setMenuContainer} className="settings-page" data-settings-tab={settingsTab} maxWidth="820px">
        <div className="settings-header">
          <Dialog.Title className="settings-title"><PiboMark size={24}/>设置</Dialog.Title>
          <Dialog.Description className="sr-only">
            管理运行环境与 Pi 模型
          </Dialog.Description>
          <Dialog.Close>
            <Button aria-label="关闭设置" variant="ghost" color="gray"
              onPointerDown={startCloseTouch} onPointerMove={moveCloseTouch}
              onPointerUp={finishCloseTouch} onPointerCancel={() => { closeTouch.current = null; }}>
              <X size={18} />
            </Button>
          </Dialog.Close>
        </div>
        <Tabs.Root
          value={settingsTab}
          onValueChange={setSettingsTab}
          orientation="vertical"
          className="settings-layout"
        >
          <Tabs.List aria-label="设置分类">
            <Tabs.Trigger value="runtime">
              <Laptop size={16} />
              工作空间
            </Tabs.Trigger>
            <Tabs.Trigger value="pi" disabled={!active}>
              模型
            </Tabs.Trigger>
          </Tabs.List>
          <ScrollArea type="auto" className="settings-body">
            <Tabs.Content value="runtime">
              <RuntimeSettings runtime={runtime} menuContainer={menuContainer} />
            </Tabs.Content>
            <Tabs.Content value="pi">
              {active && (
                <div className="settings-pane">
                  <PiSettingsPanel
                    key={active.id}
                    baseUrl={active.baseUrl}
                    runtimeLabel={active.profile?.name || "当前工作空间"}
                    registerBeforeSwitch={runtime.registerBeforeSwitch}
                    onConfigured={() => onOpenChange(false)}
                  />
                </div>
              )}
            </Tabs.Content>
          </ScrollArea>
        </Tabs.Root>
      </Dialog.Content>
    </Dialog.Root>
  );
}

export function RuntimeEditor(props) {
  const native = !!window.__PIBOT_NATIVE__;
  const [mode,setMode]=useState(props.profile?.mode||(native ? 'direct' : 'local'));
  const [name,setName]=useState(props.profile?.name||'本机工作空间'),[dataDir,setDataDir]=useState(props.profile?.dataDir||'');
  if(mode==='ssh') return <div><Text as="p">SSH 连接已停用。请返回并新建 Tailscale 或 HTTPS 连接；原配置和凭据保留，不会自动迁移。</Text><Button onClick={props.onCancel}>返回</Button></div>;
  return <div>{!props.profile?.id&&<Flex gap="2" mb="3" wrap="wrap">{native && <Button variant={mode==='direct'?'solid':'soft'} onClick={()=>setMode('direct')}>HTTP(S) 地址</Button>}{native&&props.tailscaleAvailable&&<Button variant={mode==='tailnet'?'solid':'soft'} onClick={()=>setMode('tailnet')}>Tailscale</Button>}{!props.remoteOnly&&<Button variant={mode==='local'?'solid':'soft'} onClick={()=>setMode('local')}>独立本机服务</Button>}</Flex>}{mode==='tailnet'?<TailnetConnect {...props}/>:mode==='direct'?<DirectConnect {...props}/>:<div><Field label="名称" value={name} onChange={setName}/><Field label="本机数据目录" value={dataDir} onChange={setDataDir}/><Flex gap="2" mt="3"><Button disabled={!name.trim()||!dataDir.startsWith('/')} onClick={()=>props.onSave({id:props.profile?.id||crypto.randomUUID(),name,mode:'local',dataDir})}>保存</Button><Button variant="ghost" onClick={props.onCancel}>返回</Button></Flex></div>}</div>;
}
