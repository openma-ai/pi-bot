import {PiboMark} from './PiboBrand.jsx';
import { DirectConnect } from './DirectConnect.jsx';
import { TailnetConnect } from './TailnetConnect.jsx';
import React, { useState } from "react";
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
import { NativeRuntimeDownload } from "./NativeRuntimeDownload.jsx";
const kindLabel = (profile) => (profile.mode === "local" ? "Local" : "Cloud");
function RuntimeIcon({ profile, size = 20 }) {
  return profile?.mode !== "local" ? (
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

function RuntimeSettings({ runtime }) {
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
      setNotice("已启用 " + profile.name + "。");
    } catch (e) {
      setError(e.message);
    } finally {
      setEnabling("");
    }
  }
  async function save(profile) {
    await runtime.configure(profile);
    setEditor(undefined);
    setNotice("Runtime 已保存，点击启用后使用。");
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
      {runtime.busy && <Button color="gray" variant="soft" onClick={()=>void runtime.cancelConnect()}>取消连接</Button>}
      <div className="settings-pane-heading">
        <Flex justify="between" align="center" gap="3">
          <Heading size="4">Runtime</Heading>
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
              添加 runtime
            </Button>
          )}
        </Flex>
        <Text as="p" size="2" color="gray">
          选择你的工作环境。GUI 只显示当前启用 runtime 的 bot 和消息。
        </Text>
      </div>
      <div className="runtime-cards">
        <NativeRuntimeDownload />
        {(
          profiles || [{ id: "direct", name: "当前 server", mode: "local" }]
        ).map((profile) => {
          const enabled =
              active?.profileId === profile.id ||
              (profile.id === "direct" && !!active),
            multiple = profiles?.length > 1;
          return (
            <Card
              key={profile.id}
              className="runtime-card"
              data-active={enabled}
            >
              <div className="runtime-card-header">
                <div className="runtime-card-icon">
                  <RuntimeIcon profile={profile} size={24} />
                </div>
                {runtime.managed && (
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
                    <DropdownMenu.Content>
                      <DropdownMenu.Item
                        onSelect={() => {
                          setEditor(profile);
                          setError("");
                          setNotice("");
                        }}
                      >
                        编辑
                      </DropdownMenu.Item>
                      <DropdownMenu.Item disabled={profile.mode==="ssh"} onSelect={() => void enable(profile)}>
                        重新连接
                      </DropdownMenu.Item>
                      {enabled && <DropdownMenu.Item onSelect={() => void runtime.disconnect().catch(e => setError(e.message))}>断开连接</DropdownMenu.Item>}
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item
                        color="red"
                        disabled={enabled || (profiles.length < 2 && !runtime.status.remoteOnly)}
                        onSelect={() => void remove(profile)}
                      >
                        移除连接
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                )}
              </div>
              <div className="runtime-card-copy">
                <Text size="3" weight="medium">
                  {profile.name}
                </Text>
                <Text size="1" color="gray">
                  {profile.mode === "ssh" ? "旧 SSH 配置 · 请新建连接迁移" : profile.mode === "direct" ? profile.url : profile.mode !== "local" ? profile.host : "在本机运行"}
                </Text>
              </div>
              <div className="runtime-card-footer">
                <div>
                  {multiple && (
                    <Badge color="gray" size="1">
                      {kindLabel(profile)}
                    </Badge>
                  )}
                </div>
                {enabled ? (
                  <Text size="1" className="runtime-enabled">
                    <Check size={13} />
                    已启用
                    <button className="runtime-reconnect" disabled={runtime.busy} onClick={()=>void enable(profile)}>重新连接</button>
                  </Text>
                ) : (
                  <Button
                    size="1"
                    variant="soft"
                    disabled={runtime.busy || !runtime.managed || profile.mode === "ssh"}
                    onClick={() => void enable(profile)}
                  >
                    {profile.mode === "ssh" ? "需要迁移" : enabling === profile.id ? "连接中…" : "启用"}
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>
      <Text as="p" size="1" color="gray" className="settings-note">
        每个 runtime 保留自己的 bot、群聊、消息、Pi
        配置和定时任务。切换不会结束其他 server 上的任务。
      </Text>
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
export function SettingsPage({ open, onOpenChange, runtime }) {
  const active = runtime.status.active;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="settings-page" maxWidth="820px">
        <div className="settings-header">
          <Dialog.Title className="settings-title"><PiboMark size={24}/>设置</Dialog.Title>
          <Dialog.Description className="sr-only">
            管理运行环境与 Pi 模型
          </Dialog.Description>
          <Dialog.Close>
            <Button aria-label="关闭设置" variant="ghost" color="gray">
              <X size={18} />
            </Button>
          </Dialog.Close>
        </div>
        <Tabs.Root
          defaultValue="runtime"
          orientation="vertical"
          className="settings-layout"
        >
          <Tabs.List aria-label="设置分类">
            <Tabs.Trigger value="runtime">
              <Laptop size={16} />
              Runtime
            </Tabs.Trigger>
            <Tabs.Trigger value="pi" disabled={!active}>
              Pi 模型
            </Tabs.Trigger>
          </Tabs.List>
          <ScrollArea type="auto" className="settings-body">
            <Tabs.Content value="runtime">
              <RuntimeSettings runtime={runtime} />
            </Tabs.Content>
            <Tabs.Content value="pi">
              {active && (
                <div className="settings-pane">
                  <div className="settings-pane-heading">
                    <Heading size="4">模型设置</Heading>
                    <Text as="p" size="2" color="gray">
                      {active.profile?.name || "当前 server"}的默认模型
                    </Text>
                  </div>
                  <PiSettingsPanel
                    key={active.id}
                    baseUrl={active.baseUrl}
                    registerBeforeSwitch={runtime.registerBeforeSwitch}
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
  const [mode,setMode]=useState(props.profile?.mode||'direct');
  const [name,setName]=useState(props.profile?.name||'本机工作空间'),[dataDir,setDataDir]=useState(props.profile?.dataDir||'');
  if(mode==='ssh') return <div><Text as="p">SSH 连接已停用。请返回并新建 Tailscale 或 HTTPS 连接；原配置和凭据保留，不会自动迁移。</Text><Button onClick={props.onCancel}>返回</Button></div>;
  return <div>{!props.profile?.id&&<Flex gap="2" mb="3"><Button variant={mode==='direct'?'solid':'soft'} onClick={()=>setMode('direct')}>服务地址</Button>{props.tailscaleAvailable&&<Button variant={mode==='tailnet'?'solid':'soft'} onClick={()=>setMode('tailnet')}>Tailscale</Button>}{!props.remoteOnly&&<Button variant={mode==='local'?'solid':'soft'} onClick={()=>setMode('local')}>这台 Mac</Button>}</Flex>}{mode==='tailnet'?<TailnetConnect {...props}/>:mode==='direct'?<DirectConnect {...props}/>:<div><Field label="名称" value={name} onChange={setName}/><Field label="本机数据目录" value={dataDir} onChange={setDataDir}/><Flex gap="2" mt="3"><Button disabled={!name.trim()||!dataDir.startsWith('/')} onClick={()=>props.onSave({id:props.profile?.id||crypto.randomUUID(),name,mode:'local',dataDir})}>保存</Button><Button variant="ghost" onClick={props.onCancel}>返回</Button></Flex></div>}</div>;
}
