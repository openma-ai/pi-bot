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
  SegmentedControl,
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
  return profile?.mode === "ssh" ? (
    <Cloud size={size} />
  ) : (
    <Laptop size={size} />
  );
}
export function RuntimePicker({ runtime }) {
  const { status, busy, connect } = runtime,
    profiles = status.profiles;
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
function RuntimeEditor({ profile, onSave, onCancel }) {
  const [mode, setMode] = useState(profile?.mode || "ssh"),
    [name, setName] = useState(profile?.name || ""),
    [host, setHost] = useState(profile?.host || "");
  const [project, setProject] = useState(profile?.projectDir || "~/pi-bot"),
    [localDir, setLocalDir] = useState(
      profile?.mode === "local"
        ? profile.dataDir
        : "work/runtimes/" + crypto.randomUUID(),
    ),
    [remoteDir, setRemoteDir] = useState(
      profile?.mode === "ssh" ? profile.dataDir : "work/gui/demo",
    );
  const [agentDir, setAgentDir] = useState(profile?.agentDir || ""),
    [node, setNode] = useState(profile?.node || "node"),
    [port, setPort] = useState(String(profile?.sshPort || "")),
    [serverPort, setServerPort] = useState(String(profile?.serverPort ?? 0)),
    [configFile, setConfigFile] = useState(profile?.configFile || "");
  const [advanced, setAdvanced] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave(
        mode === "local"
          ? {
              mode,
              ...(profile?.id ? { id: profile.id } : {}),
              name: name.trim(),
              dataDir: localDir.trim(),
              ...(agentDir.trim() ? { agentDir: agentDir.trim() } : {}),
            }
          : {
              mode,
              ...(profile?.id ? { id: profile.id } : {}),
              name: name.trim(),
              host: host.trim(),
              projectDir: project.trim(),
              dataDir: remoteDir.trim(),
              node: node.trim(),
              serverPort: Number(serverPort),
              ...(port ? { sshPort: Number(port) } : {}),
              ...(configFile.trim() ? { configFile: configFile.trim() } : {}),
            },
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="runtime-editor" onSubmit={save}>
      <Button
        type="button"
        variant="ghost"
        color="gray"
        className="settings-back"
        onClick={onCancel}
      >
        <ArrowLeft size={15} />
        所有 runtime
      </Button>
      <div className="settings-pane-heading">
        <Heading size="4">{profile ? "编辑 runtime" : "添加 runtime"}</Heading>
        <Text as="p" size="2" color="gray">
          先保存，再启用。已有任务和数据会留在原来的 server。
        </Text>
      </div>
      {!profile && (
        <SegmentedControl.Root
          aria-label="Runtime 类型"
          value={mode}
          onValueChange={setMode}
        >
          <SegmentedControl.Item value="local">
            <Laptop size={15} />
            本机
          </SegmentedControl.Item>
          <SegmentedControl.Item value="ssh">
            <Cloud size={15} />
            SSH
          </SegmentedControl.Item>
        </SegmentedControl.Root>
      )}
      <Field
        label="Runtime 名称"
        value={name}
        onChange={setName}
        placeholder={mode === "local" ? "例如：个人工作区" : "例如：开发服务器"}
      />
      {mode === "ssh" && (
        <>
          <Field
            label="SSH 主机"
            value={host}
            onChange={setHost}
            placeholder="user@vps 或 SSH 别名"
          />
          <Text size="1" color="gray">
            使用客户端的 SSH 配置与密钥。远程需先安装 Pi Bot，默认目录为
            ~/pi-bot。
          </Text>
        </>
      )}
      <Button
        type="button"
        variant="ghost"
        color="gray"
        size="2"
        className="settings-advanced"
        aria-expanded={advanced}
        onClick={() => setAdvanced((v) => !v)}
      >
        <ChevronDown size={14} />
        高级设置
      </Button>
      {advanced && (
        <div className="settings-fields">
          {mode === "local" ? (
            <>
              <Field
                label="本机数据目录"
                value={localDir}
                onChange={setLocalDir}
              />
              <Field
                label="Pi 配置目录"
                value={agentDir}
                onChange={setAgentDir}
                placeholder={
                  profile?.id === "local"
                    ? "读取本机 Pi 配置"
                    : "留空则使用独立配置"
                }
              />
            </>
          ) : (
            <>
              <Field
                label="远程 Pi Bot 目录"
                value={project}
                onChange={setProject}
              />
              <Field
                label="远程数据目录"
                value={remoteDir}
                onChange={setRemoteDir}
              />
              <Field
                label="SSH 端口"
                value={port}
                onChange={setPort}
                placeholder="使用 SSH 配置"
                type="number"
              />
              <Field
                label="Server 端口"
                value={serverPort}
                onChange={setServerPort}
                placeholder="0 为自动选择"
                type="number"
              />
              <Field
                label="SSH 配置文件"
                value={configFile}
                onChange={setConfigFile}
                placeholder="默认 ~/.ssh/config"
              />
              <Field label="远程 Node 路径" value={node} onChange={setNode} />
            </>
          )}
        </div>
      )}
      {error && (
        <Text as="p" size="2" color="red" role="alert">
          {error}
        </Text>
      )}
      <Flex justify="end" gap="2">
        <Button
          type="button"
          variant="soft"
          color="gray"
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </Button>
        <Button
          type="submit"
          disabled={busy || !name.trim() || (mode === "ssh" && !host.trim())}
        >
          {busy ? "正在保存…" : profile ? "保存更改" : "添加 runtime"}
        </Button>
      </Flex>
    </form>
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
          onSave={save}
          onCancel={() => setEditor(undefined)}
        />
      </div>
    );
  return (
    <div className="settings-pane">
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
                      <DropdownMenu.Item onSelect={() => void enable(profile)}>
                        重新连接
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item
                        color="red"
                        disabled={enabled || profiles.length < 2}
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
                  {profile.mode === "ssh" ? profile.host : "在本机运行"}
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
                  </Text>
                ) : (
                  <Button
                    size="1"
                    variant="soft"
                    disabled={runtime.busy || !runtime.managed}
                    onClick={() => void enable(profile)}
                  >
                    {enabling === profile.id ? "连接中…" : "启用"}
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
          <Dialog.Title>设置</Dialog.Title>
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
