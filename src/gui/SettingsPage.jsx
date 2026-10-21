import React, { useState, useRef } from "react";
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
export function RuntimeEditor({ profile, onSave, onCancel, remoteOnly = false, sessionOnly = false, tailscaleAvailable = false,onboarding=false,tailState,knownProfile=!!profile }) {
  const [mode, setMode] = useState(profile?.mode || "ssh"),
    [name, setName] = useState(profile?.name || ""),
    [host, setHost] = useState(profile?.host || "");
  const [embeddedTailscale, setEmbeddedTailscale] = useState(!!profile?.embeddedTailscale);
  const [tailKey, setTailKey] = useState("");
  const [tailReady,setTailReady] = useState(false);
  const nativeAuth = remoteOnly || embeddedTailscale;
  const keyInput = useRef();
  const [authMethod,setAuthMethod]=useState("password"), [passphrase,setPassphrase]=useState(""), [saveCredentials,setSaveCredentials]=useState(false), [interactive,setInteractive]=useState(false);
  const [profileId] = useState(() => profile?.id || crypto.randomUUID());
  const [hostKey, setHostKey] = useState(profile?.hostKey || ""),
    [password, setPassword] = useState("");
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
  async function readPrivateKey(file) { if(file.size > 131072) throw Error("私钥文件不能超过 128 KiB"); return file.text(); }
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if(onboarding && nativeAuth && !knownProfile && authMethod==="password" && !password)throw Error("请输入远程电脑的登录密码");
      if(onboarding && nativeAuth && !knownProfile && authMethod==="privateKey" && !keyInput.current?.files?.[0])throw Error("请选择 SSH 私钥文件");
      await onSave(
        mode === "local"
          ? {
              mode,
              id: profileId,
              name: name.trim(),
              dataDir: localDir.trim(),
              ...(agentDir.trim() ? { agentDir: agentDir.trim() } : {}),
            }
          : {
              mode,
              id: profileId,
              name: name.trim(),
              host: host.trim(),
              ...(nativeAuth ? { hostKey: hostKey.trim() } : {}),
              ...(embeddedTailscale ? { embeddedTailscale: true } : {}),
              projectDir: project.trim(),
              dataDir: remoteDir.trim(),
              node: node.trim(),
              serverPort: Number(serverPort),
              ...(port ? { sshPort: Number(port) } : {}),
              ...(!nativeAuth && configFile.trim() ? { configFile: configFile.trim() } : {}),
            },
        nativeAuth ? {method:authMethod,password:authMethod === "password" ? password : "",privateKey: authMethod === "privateKey" && keyInput.current?.files?.[0] ? await readPrivateKey(keyInput.current.files[0]) : "",passphrase:authMethod === "privateKey" ? passphrase : "",interactive} : null,
        saveCredentials,
      );
      setPassword(""); setPassphrase(""); if(keyInput.current) keyInput.current.value="";
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
        {onboarding?"返回选择位置":"所有 runtime"}
      </Button>
      <div className="settings-pane-heading">
        {!onboarding&&<Heading size="4">{profile ? "编辑 runtime" : "添加 runtime"}</Heading>}
        <Text as="p" size="2" color="gray">
          {onboarding?"填写已有服务的位置。保存后直接尝试连接，现有任务和数据不会迁移。":"先保存，再启用。已有任务和数据会留在原来的 server。"}
        </Text>
      </div>
      {!profile && !remoteOnly && (
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
        label={onboarding?"工作空间名称":"Runtime 名称"}
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
            placeholder={nativeAuth ? "user@hostname" : "user@vps 或 SSH 别名"}
          />
          <Text size="1" color="gray">
            {nativeAuth ? "支持密码、Ed25519/RSA 私钥与交互验证；主机公钥必须通过可信渠道核验，不会自动接受未知或变更的主机。" : "使用客户端的 SSH 配置与密钥。远程需先安装并独立启动 Pi Bot。"}
          </Text>
          {window.__PIBOT_NATIVE__ && tailscaleAvailable && (!onboarding || embeddedTailscale) && <>
            {!onboarding&&<label><input type="checkbox" checked={embeddedTailscale} onChange={e=>setEmbeddedTailscale(e.target.checked)} />应用内 Tailscale（实验性）</label>}
            {embeddedTailscale && <>
              <Text size="1" color="gray">{onboarding?"为 Pibo 授权此设备后，才会尝试连接私有网络。远程电脑需要另行登录；当前 VPN 仍可能影响连接。":"仅此应用使用用户态 Tailnet；外层连接仍受当前 VPN 路由影响。启用 runtime 会使用 auth key 注册临时节点；状态只写临时目录，正常退出清理，异常退出可能留存。iOS 回前台会重新连接。"}</Text>
              <Text as="p" size="1">此应用：{tailReady||["prepared","dialed"].includes(tailState)?"已准备授权":"待授权"}。远程电脑需另行登录同一网络；此处无法代它登录。</Text>
              <Field label="应用授权密钥（Tailscale，仅本次）" type="password" value={tailKey} onChange={setTailKey} />
              <Button type="button" disabled={busy || !tailKey} onClick={async()=>{setBusy(true);setError("");const authKey=tailKey;setTailKey("");try{await window.__PIBOT_NATIVE__.call("runtime_control",{method:"tailscale/start",params:{authKey}});setTailReady(true);}catch(e){setError(String(e));}finally{setBusy(false);}}}>准备应用授权</Button>
              {tailReady && <Text size="1">授权信息已准备；连接时才会注册临时节点。</Text>}
              <Button type="button" onClick={async()=>{try{await window.__PIBOT_NATIVE__.call("runtime_control",{method:"tailscale/stop",params:{}});setTailReady(false);}catch(e){setError(String(e));}}}>停止内嵌节点并断开</Button>
            </>}
          </>}
          {nativeAuth && <>
            <Field label="已核验的 SSH 主机公钥" value={hostKey} onChange={setHostKey} placeholder="ssh-ed25519 AAAA…（完整公钥，不是 SHA256 指纹）" />
            <label>认证方式<select aria-label="SSH 认证方式" value={authMethod} onChange={e=>{setAuthMethod(e.target.value);setPassword("");setPassphrase("");if(keyInput.current)keyInput.current.value="";}}><option value="password">密码</option><option value="privateKey">私钥文件</option><option value="interactive">交互验证</option></select></label>
            {authMethod === "password" && <Field label="SSH 密码" value={password} onChange={setPassword} type="password" placeholder={onboarding?"输入登录密码（如已保存可留空）":profile?.id ? "留空保留已有凭据" : "输入 SSH 密码"} />}
            {authMethod === "privateKey" && <><label>私钥文件（不会显示正文）<input ref={keyInput} type="file" aria-label="导入 SSH 私钥" /></label><Field label="私钥口令（如已加密）" type="password" value={passphrase} onChange={setPassphrase} /></>}
            {authMethod !== "interactive" && <label><input type="checkbox" checked={interactive} onChange={e=>setInteractive(e.target.checked)} />需要附加交互验证（例如验证码）</label>}
            {!sessionOnly && remoteOnly && <label><input type="checkbox" checked={saveCredentials} onChange={e=>setSaveCredentials(e.target.checked)} />将本次凭据保存到此设备 Keychain</label>}
            <Text size="1" color="gray">{sessionOnly ? "Android 测试版凭据仅在内存中，关闭进程后需要重新输入/导入；不会写入文件。" : (remoteOnly ? "默认仅在内存使用；可选择 Keychain 保存，保存私钥时口令也受同样保护。" : "内嵌连接的 SSH 凭据仅在当前进程内存中使用。")} 验证码从不保存。暂不支持硬件密钥、SSH agent、证书或网页登录式 MFA。</Text>
          </>}
        </>
      )}
      {onboarding&&<div className="settings-fields">{mode==="local"?<><Field label="本机服务数据目录" value={localDir} onChange={setLocalDir} placeholder="例如 /Users/me/pibo/work/runtime"/><Text size="1" color="gray">填写已启动服务的目录，其中应包含 daemon.json。客户端不会替你启动服务。</Text></>:<><Field label="远程 Pibo 项目目录" value={project} onChange={setProject} placeholder="例如 ~/pi-bot"/><Field label="服务数据目录" value={remoteDir} onChange={setRemoteDir} placeholder="例如 ~/pi-bot/work/runtime"/><Text size="1" color="gray">填写远程服务的实际目录（含 daemon.json）；路径不会自动创建。</Text></>}</div>}
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
              {!nativeAuth && <Field
                label="SSH 配置文件"
                value={configFile}
                onChange={setConfigFile}
                placeholder="默认 ~/.ssh/config"
              />}
              {!nativeAuth && <Field label="远程 Node 路径" value={node} onChange={setNode} />}
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
          disabled={busy || (onboarding&&embeddedTailscale&&!tailReady&&!["prepared","dialed"].includes(tailState)) || !name.trim() || (mode === "ssh" && (!host.trim() || (onboarding&&(!project.trim()||!remoteDir.trim())))) || (onboarding&&mode==="local"&&!localDir.trim())}
        >
          {busy ? "正在处理…" : onboarding?"连接工作空间":profile ? "保存更改" : "添加 runtime"}
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
  async function save(profile, credentials, saveCredentials) {
    await runtime.configure(profile);
    if ((runtime.status.remoteOnly || profile.embeddedTailscale) && credentials && (credentials.method === "interactive" || credentials.password || credentials.privateKey)) {
      await window.__PIBOT_NATIVE__.call("ssh_credentials_set", { profileId: profile.id, credentials, save: runtime.status.remoteOnly && saveCredentials });
    }
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
                      <DropdownMenu.Item onSelect={() => void enable(profile)}>
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
                    <button className="runtime-reconnect" disabled={runtime.busy} onClick={()=>void enable(profile)}>重新连接</button>
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
