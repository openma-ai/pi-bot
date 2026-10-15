import { layoutMessages, isUserMessage } from "./message-layout.ts";
import { senderLabelColor } from "./identity-color.ts";
import { conversationPalette } from "./identity-color.ts";
import { AvatarEditor } from "./AvatarEditor.jsx";
import { ErrorBoundary } from "./ErrorBoundary.jsx";
import { useConversationDraft } from "./hooks/use-conversation-draft.js";
import { Notification, ServiceNotice, ConnectionFeedback } from "./Notification.jsx";
import { TaskFailure } from "./TaskFailure.jsx";
import { ConversationRequests } from "./ConversationRequests.jsx";
import { SearchDialog } from "./SearchDialog.jsx";
import { MessengerSidebar } from "./MessengerSidebar.jsx";
import { SidebarProvider } from "./ui/sidebar.jsx";
import { useIsMobile } from "./hooks/use-mobile.js";
import { useConversationRoute } from "./hooks/use-conversation-route.js";
import { Textarea as ComposerTextarea } from "./ui/textarea.jsx";
import "./components.css";
import {
  BotAvatar,
  GroupAvatar,
  activityLabels,
  AvatarContext,
} from "./BotAvatar.jsx";
import { MessageBody } from "./MessageBody.jsx";
import { botActivity, messageFailures } from "./presentation.ts";
import {
  Plus,
  Search,
  Settings2,
  PanelRight,
  X,
  ArrowUp,
  Menu,
  Clock3,
  Radar,
  MessagesSquare,
  ChevronDown,
  ChevronLeft,
} from "lucide-react";
import { Tabs } from "@radix-ui/themes";
import { SettingsPage } from "./SettingsPage.jsx";
import { useRuntime } from "./useRuntime.js";
import { DesktopPanel } from "./DesktopPanel.jsx";
import React, { useState, useEffect, useRef, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  Theme,
  Button,
  TextField,
  TextArea,
  Heading,
  Text,
  Badge,
  Dialog,
  Flex,
  Callout,
  Select,
  Checkbox,
  Switch,
  IconButton,
} from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "./style.css";
import { useDaemon, errorText } from "./useDaemon.js";
// Layer ④ GUI talks to the daemon only through the SDK client.

const labels = {
  queued: "待处理",
  processing: "处理中",
  processed: "已处理",
  uncertain: "执行中断",
  failed: "失败",
  delivered: "已送达",
  active: "运行中",
  paused: "已暂停",
  completed: "已完成",
  cancelled: "已取消",
  expired: "已到期",
  received: "已发送",
};
const time = (n) =>
  new Date(n).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });
function displayText(m) {
  try {
    const value = JSON.parse(m.text);
    if (
      typeof value.questionId === "string" &&
      typeof value.question === "string"
    )
      return value.question;
    if (m.sourceKind === "answer" && typeof value.answer === "string")
      return value.answer;
  } catch {}
  if (["schedule", "monitor"].includes(m.sourceKind)) {
    try {
      const e = JSON.parse(m.text);
      return (
        (m.sourceKind === "schedule" ? "定时任务已触发：" : "监控发现变化：") +
        (e.prompt || e.observation || "")
      );
    } catch {}
  }
  return m.text;
}
function Picker({ value, onChange, items, label }) {
  return (
    <Select.Root value={value || undefined} onValueChange={onChange}>
      <Select.Trigger aria-label={label} placeholder={label} />
      <Select.Content>
        {items.map((i) => (
          <Select.Item key={i.id} value={i.id}>
            {i.name}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}
function App({ runtime, setPiSettingsOpen }) {
  const activeRuntime = runtime.status.active;
  const phone = useIsMobile();
  const nativeMac = Boolean(window.__PIBOT_NATIVE__) && /^Mac/.test(navigator.platform) && navigator.maxTouchPoints < 2;
  const navigation = useConversationRoute();
  const {
    data,
    client: api,
    error: connectionError,
    phase: connectionPhase,
  } = useDaemon(activeRuntime?.baseUrl ?? null);
  const [view, setView] = useState("chat"),
    [selected, setSelected] = useState(""),
    [groupId, setGroupId] = useState(""),
    [groupTarget, setGroupTarget] = useState("");
  const [peerA, setPeerA] = useState(""),
    [peerB, setPeerB] = useState(""),
    [peerScope, setPeerScope] = useState("direct");
  const [draft, setDraft] = useConversationDraft(
      JSON.stringify([
        activeRuntime?.scope,
        view === "peers"
          ? [view, peerA, peerB, peerScope]
          : `${view}:${view === "group" ? groupId : selected}`,
      ]),
    ),
    [searchOpen, setSearchOpen] = useState(false),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (runtime.error) setNotice(runtime.error);
  }, [runtime.error]);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      return Math.max(
        76,
        Math.min(520, Number(localStorage.getItem("pi-sidebar-width")) || Math.round(window.innerWidth * .255)),
      );
    } catch {
      return 236;
    }
  });
  const [searchTarget, setSearchTarget] = useState("");
  const [inspectTask, setInspectTask] = useState(""),
    [serviceDetails, setServiceDetails] = useState(false),
    [runtimeDetailsOpen, setRuntimeDetailsOpen] = useState(false);
  const resizeSidebar = (width) => {
    const next = Math.max(76, Math.min(520, width));
    setSidebarWidth(next);
    try {
      localStorage.setItem("pi-sidebar-width", String(next));
    } catch {}
  };
  useEffect(() => {
    const shortcut = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b" && window.innerWidth >= 768) {
        e.preventDefault(); resizeSidebar(sidebarWidth < 156 ? Math.min(520, Math.max(236, Math.round(window.innerWidth * .255))) : 76);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [sidebarWidth]);
  const chooseConversation = (row, routeState) => {
    navigation.open(row.kind, row.id, routeState);
    if (row.kind === "group") {
      setGroupId(row.id);
      setSelected(row.group.memberIds[0]);
      setView("group");
    } else {
      setSelected(row.id);
      setView("chat");
    }
    setDetails(false);
    setInspectTask("");
    setRuntimeDetailsOpen(false);
  };
  useLayoutEffect(() => {
    if (navigation.route.page !== "chat") { setDetails(false); return; }
    const { kind, id } = navigation.route;
    if (data.status === "ready" && !(kind === "group" ? data.groups : data.bots).some((row) => row.id === id)) {
      setNotice("会话不存在或不属于当前 runtime。"); navigation.list(); return;
    }
    if (kind === "group") {
      const row = data.groups.find((group) => group.id === id);
      if (row) { setGroupId(id); setSelected(row.memberIds[0]); setView("group"); }
    } else if (data.bots.some((bot) => bot.id === id)) { setSelected(id); setView("chat"); }
  }, [navigation.route, data.bots, data.groups]);
  useEffect(() => {
    if (!phone) return;
    const viewport = window.visualViewport;
    const update = () => {
      // A user pinch zoom must not resize the layout to the magnified viewport.
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      const height = viewport?.height || window.innerHeight;
      document.documentElement.style.setProperty("--phone-height", `${height}px`);
      document.documentElement.style.setProperty("--phone-bottom-inset", height < window.innerHeight - 80 ? "0px" : "env(safe-area-inset-bottom)");
    };
    update(); viewport?.addEventListener("resize", update); window.addEventListener("resize", update);
    return () => { viewport?.removeEventListener("resize", update); window.removeEventListener("resize", update); document.documentElement.style.removeProperty("--phone-height"); document.documentElement.style.removeProperty("--phone-bottom-inset"); };
  }, [phone]);
  useLayoutEffect(() => {
    if (!searchTarget) return;
    const message = Array.from(
      conversation.current?.querySelectorAll("[data-message-id]") ?? [],
    ).find((el) => el.dataset.messageId === searchTarget);
    if (message) {
      pinnedToEnd.current = false;
      message.scrollIntoView({ block: "center", behavior: "instant" });
      message.classList.add("search-highlight");
      const timer = setTimeout(() => {
        message.classList.remove("search-highlight");
        setSearchTarget("");
      }, 2000);
      return () => {
        clearTimeout(timer);
        message.classList.remove("search-highlight");
      };
    }
  }, [searchTarget, view, selected, groupId]);
  const [adding, setAdding] = useState(false),
    [name, setName] = useState(""),
    [newGroup, setNewGroup] = useState(false),
    [members, setMembers] = useState([]),
    [details, setDetails] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [routineOwner, setRoutineOwner] = useState("");
  const [routineKind, setRoutineKind] = useState(""),
    [prompt, setPrompt] = useState(""),
    [when, setWhen] = useState(""),
    [interval, setIntervalMinutes] = useState(""),
    [watchPath, setWatchPath] = useState(""),
    [routineGroup, setRoutineGroup] = useState("direct");
  const [result, setResult] = useState(""),
    [answer, setAnswer] = useState(""),
    [mentionIndex, setMentionIndex] = useState(0),
    [hideMentions, setHideMentions] = useState(false);
  const end = useRef(null),
    composer = useRef(null),
    conversation = useRef(null),
    pinnedToEnd = useRef(true),
    lastScope = useRef("");
  const scrollPositions = useRef(new Map());
  const [atBottom, setAtBottom] = useState(true),
    [wide, setWide] = useState(() => matchMedia("(min-width: 1100px)").matches);
  useEffect(() => {
    const media = matchMedia("(min-width: 1100px)");
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (pinnedToEnd.current)
        end.current?.scrollIntoView({ behavior: "instant", block: "end" });
    });
    if (conversation.current) observer.observe(conversation.current);
    return () => observer.disconnect();
  }, [view]);
  useLayoutEffect(() => {
    const input = composer.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    input.style.overflowY = input.scrollHeight > 160 ? "auto" : "hidden";
  }, [draft, view]);
  const activity = (id) => botActivity(data, id);
  const scrollBottom = () => {
    end.current?.scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      block: "end",
    });
    pinnedToEnd.current = true;
    setAtBottom(true);
  };
  useEffect(() => {
    setSelected((s) => s || data.bots[0]?.id);
    setPeerA((s) => s || data.bots[0]?.id);
    setPeerB((s) => s || data.bots[1]?.id);
  }, [data.bots, connectionError]);
  const bot = data.bots.find((b) => b.id === selected),
    group = data.groups.find((g) => g.id === groupId),
    state = data.states[selected];
  const outgoingPalette = conversationPalette(view, bot?.id, bot?.avatar);
  const botUsage = (data.turns || [])
    .filter((t) => t.botId === selected)
    .reduce(
      (sum, t) => ({
        output: sum.output + (t.usage?.output ?? 0),
        estimatedUsd: sum.estimatedUsd + (t.usage?.costUsd ?? 0),
      }),
      { output: 0, estimatedUsd: 0 },
    );
  const botName = (id) => data.bots.find((b) => b.id === id)?.name || id;
  const groupBots = data.bots.filter((b) => group?.memberIds.includes(b.id));
  const scopeMatches = (m) =>
    peerScope === "direct"
      ? m.channelId.startsWith("local:")
      : m.channelId === peerScope;
  const peerMessages = data.messages.filter(
    (m) =>
      m.sourceKind === "bot" &&
      m.direction === "inbound" &&
      scopeMatches(m) &&
      ((m.sender === peerA && m.recipient === peerB) ||
        (m.sender === peerB && m.recipient === peerA)),
  );
  const peerTasks = new Set(peerMessages.map((m) => m.taskId));
  const shared = (data.groupMessages || []).filter(
    (m) =>
      m.channelId === groupId &&
      (m.direction !== "outbound" || m.status === "delivered"),
  );
  const sharedIds = new Set(shared.map((m) => m.messageId));
  const legacy = data.messages.filter(
    (m) =>
      m.channelId === groupId &&
      m.sourceKind !== "job" &&
      !m.groupMessageId &&
      !sharedIds.has(m.messageId) &&
      !(m.direction === "inbound" && m.sourceKind === "bot"),
  );
  const groupMessages = [...shared, ...legacy].sort(
    (a, b) => a.receivedAt - b.receivedAt,
  );
  const messages =
    view === "group"
      ? groupMessages
      : view === "peers"
        ? data.messages.filter(
            (m) =>
              peerMessages.includes(m) ||
              (peerTasks.has(m.taskId) && m.direction === "outbound") ||
              (m.sourceKind === "user" &&
                m.recipient === peerA &&
                m.text.startsWith("协作任务：") &&
                m.text.includes(peerB) &&
                scopeMatches(m)),
          )
        : data.messages.filter(
            (m) =>
              m.botId === selected &&
              m.channelId === (bot?.channelId || `local:${selected}`) &&
              m.sourceKind !== "job" &&
              !(m.direction === "inbound" && m.sourceKind === "bot"),
          );
  const privateFrom = view === "chat" && navigation.route.kind === "bot" && navigation.route.id === selected && history.state?.piPrivateScope === activeRuntime?.scope && data.groups.some(g => g.id === history.state?.piPrivateFrom) ? history.state.piPrivateFrom : null;
  function openSenderConversation(senderId) {
    const sender = data.bots.find(b => b.id === senderId);
    if (!sender) { setNotice("该成员已不可用，无法打开私聊。"); return; }
    if (conversation.current) scrollPositions.current.set(lastScope.current, { top: conversation.current.scrollTop, bottom: pinnedToEnd.current });
    navigation.open("group", groupId);
    chooseConversation({ kind: "bot", id: sender.id }, { piPrivateFrom: groupId, piPrivateScope: activeRuntime?.scope });
  }
  const laidOutMessages = layoutMessages(messages, view === "group", data.bots);
  const mentionMatch =
    view === "group" && !hideMentions
      ? draft.match(/(?:^|\s)@([^\s]*)$/)
      : null;
  const mentionOptions = mentionMatch
    ? [...groupBots.map((b) => b.name), "全体成员"].filter((name) =>
        name.includes(mentionMatch[1]),
      )
    : [];
  function chooseMention(name) {
    setDraft((s) =>
      s.replace(/(^|\s)@[^\s]*$/, (_match, space) => space + "@" + name + " "),
    );
    setMentionIndex(0);
    setHideMentions(false);
    requestAnimationFrame(() => composer.current?.focus());
  }
  const scrollKey = messages.map((m) => m.direction + m.messageId).join("|");
  useLayoutEffect(() => {
    const scope = [activeRuntime?.scope, view, selected, groupId, peerA, peerB, peerScope].join(":");
    const saved = scrollPositions.current.get(scope);
    if (scope !== lastScope.current && saved) {
      if (conversation.current) conversation.current.scrollTop = saved.top;
      pinnedToEnd.current = saved.bottom;
      setAtBottom(saved.bottom);
    } else if (pinnedToEnd.current || scope !== lastScope.current) {
      end.current?.scrollIntoView({ behavior: "instant", block: "end" });
      pinnedToEnd.current = true;
      setAtBottom(true);
    }
    lastScope.current = scope;
  }, [activeRuntime?.scope, view, selected, groupId, peerA, peerB, peerScope, scrollKey]);
  useLayoutEffect(() => {
    if (!phone || navigation.route.page !== "chat") return;
    const saved = scrollPositions.current.get(lastScope.current);
    if (saved && conversation.current) conversation.current.scrollTop = saved.top;
    else end.current?.scrollIntoView({ behavior: "instant", block: "end" });
  }, [phone, navigation.route]);
  /** Run an SDK write, then refresh the snapshot. */
  async function mutate(write) {
    const v = await write;
    return v;
  }
  const [sendFailures, setSendFailures] = useState({});
  const sendScope = JSON.stringify([activeRuntime?.scope, view, selected, groupId, peerA, peerB, peerScope]);
  const sendFailure = sendFailures[sendScope];
  async function send(retry = false) {
    if (!(retry ? sendFailure?.draft : draft)?.trim() || busy || !api || connectionPhase !== "ready") return;
    if (sendFailure?.uncertain && (retry || sendFailure.draft === draft)) return;
    setBusy(true);
    setNotice("");
    const attempt = sendFailure && (retry || sendFailure.draft === draft) ? sendFailure : { key: crypto.randomUUID(), draft };
    try {
      const to =
        view === "group"
          ? groupBots[0]?.id
          : view === "peers"
            ? peerA
            : selected;
      if (!to || (view === "peers" && (!peerB || peerA === peerB)))
        throw Error("请选择不同的 bot");
      const text =
        view === "peers"
          ? `协作任务：${attempt.draft}\n请使用 send_to_bot 将任务交给 ${botName(peerB)}（${peerB}）。对方完成后使用 send_to_bot 将结果返回给你（${peerA}）；你核验后使用 send_message 给用户最终结果。你负责最终回复。不要互相发确认或闲聊，不要创建额外任务。`
          : attempt.draft;
      await mutate(
        api.turn.start({
          botId: to,
          text,
          key: attempt.key,
          groupId:
            view === "group"
              ? groupId
              : view === "peers" && peerScope !== "direct"
                ? peerScope
                : undefined,
        }),
      );
      setDraft((current) => current === attempt.draft ? "" : current);
      setSendFailures((old) => { const next = { ...old }; delete next[sendScope]; return next; });
      pinnedToEnd.current = true;
    } catch (e) {
      setSendFailures((old) => ({ ...old, [sendScope]: { ...attempt, message: errorText(e), uncertain: ["reviewRequired", "conflict"].includes(e?.reason) } }));
    } finally {
      setBusy(false);
    }
  }
  const action = async (kind, r, act) => {
    try {
      const v = await mutate(
        api.routine[act === "dry-run" ? "dryRun" : act]({
          routineId: kind + ":" + r.id,
        }),
      );
      if (act === "dry-run")
        setNotice(
          v.decision === "error"
            ? "试运行失败：" + v.error
            : "试运行通过：" + v.decision,
        );
    } catch (e) {
      setNotice(errorText(e));
    }
  };
  function openRoutine(kind) {
    setNotice("");
    setRoutineKind(kind);
    setRoutineOwner(selected || data.bots[0]?.id || "");
    setRoutineGroup(view === "group" ? groupId : "direct");
  }
  function routineCard(kind, r) {
    return (
      <div className="routine" key={r.id}>
        <Flex gap="2" align="center" wrap="wrap">
          <Text weight="medium">
            {kind === "schedule" ? "定时任务" : "监控"}
          </Text>
          <Badge color={r.state === "active" ? "green" : "gray"}>
            {kind === "schedule" && r.state === "completed"
              ? "已触发"
              : kind === "monitor" && r.state === "active" && !r.enabled
                ? "未启用"
                : labels[r.state] || r.state}
          </Badge>
          {r.dryRunVerified && <Badge color="green">试运行通过</Badge>}
        </Flex>
        <Text size="2">{r.prompt}</Text>
        <Text size="1" color="gray">
          {kind === "schedule"
            ? `执行时间：${time(r.nextFire)} · ${r.intervalMs ? `每 ${r.intervalMs / 60000} 分钟` : "仅一次"}`
            : `${r.detector === "file" ? data.watchFile : r.detector.replace(/^file:/, "")} · 每 ${r.intervalMs / 1000} 秒 · 截止 ${time(r.deadline)}`}
        </Text>
        {kind === "monitor" && (
          <Text size="1" color="gray">
            {r.enabled ? "已启用" : "未启用"} · 最近检查：
            {{ silent: "无变化", wake: "发现变化", error: "检查失败" }[
              r.lastDecision
            ] || "尚未检查"}
          </Text>
        )}
        <Flex gap="3" wrap="wrap" align="center">
          {kind === "schedule" && ["active", "paused"].includes(r.state) && (
            <Switch
              aria-label={
                r.state === "active" ? "暂停定时任务" : "恢复定时任务"
              }
              checked={r.state === "active"}
              onCheckedChange={(checked) =>
                action(kind, r, checked ? "resume" : "pause")
              }
            />
          )}
          {kind === "monitor" && r.state === "active" && (
            <>
              <Button
                size="1"
                variant="soft"
                onClick={() => action(kind, r, "dry-run")}
              >
                试运行
              </Button>
              <Switch
                aria-label={r.enabled ? "暂停监控" : "启用监控"}
                checked={!!r.enabled}
                onCheckedChange={(checked) =>
                  action(kind, r, checked ? "enable" : "pause")
                }
              />
            </>
          )}
          {["active", "paused"].includes(r.state) && (
            <Button
              variant="soft"
              size="1"
              color="red"
              onClick={() => action(kind, r, "cancel")}
            >
              取消
            </Button>
          )}
        </Flex>
        {r.error && (
          <Text size="1" color="red">
            {r.error}
          </Text>
        )}
      </div>
    );
  }
  const routineRows =
    view === "schedules"
      ? state?.proactive?.schedules || []
      : state?.proactive?.monitors || [];
  const routineView = ["schedules", "monitors"].includes(view),
    kind = view === "schedules" ? "schedule" : "monitor";
  const title =
    view === "requests"
      ? "待处理"
      : routineView
        ? view === "schedules"
          ? "定时任务"
          : "监控"
        : view === "peers"
          ? "Bot 对话"
          : view === "group"
            ? group?.name
            : bot?.name;
  const inspector = (
    <>
      <div className="details-section">
        <Flex justify="between" align="center">
          <Text size="2" color="gray">
            定时任务
          </Text>
          <IconButton
            variant="ghost"
            aria-label="新建定时任务"
            onClick={() => openRoutine("schedule")}
          >
            <Plus size={17} />
          </IconButton>
        </Flex>
        {state?.proactive?.schedules?.some((r) =>
          ["active", "paused"].includes(r.state),
        ) ? (
          state.proactive.schedules
            .filter((r) => ["active", "paused"].includes(r.state))
            .map((r) => routineCard("schedule", r))
        ) : (
          <Text as="p" size="2" color="gray">
            还没有定时任务
          </Text>
        )}
      </div>
      <div className="details-section">
        <Flex justify="between" align="center">
          <Text size="2" color="gray">
            监控
          </Text>
          <IconButton
            variant="ghost"
            aria-label="新建监控"
            onClick={() => openRoutine("monitor")}
          >
            <Plus size={17} />
          </IconButton>
        </Flex>
        {state?.proactive?.monitors?.some((r) =>
          ["active", "paused"].includes(r.state),
        ) ? (
          state.proactive.monitors
            .filter((r) => ["active", "paused"].includes(r.state))
            .map((r) => routineCard("monitor", r))
        ) : (
          <Text as="p" size="2" color="gray">
            还没有监控
          </Text>
        )}
      </div>
      <Button
        variant="soft"
        color="gray"
        onClick={() => {
          setPeerA(selected);
          setPeerB(data.bots.find((b) => b.id !== selected)?.id || "");
          setPeerScope("direct");
          setDetails(false);
          setView("peers");
        }}
        disabled={data.bots.length < 2}
      >
        让其他 bot 协作
      </Button>
      <details
        className="runtime-details"
        open={runtimeDetailsOpen}
        onToggle={(e) => {
          setRuntimeDetailsOpen(e.currentTarget.open);
          if (!e.currentTarget.open) setInspectTask("");
        }}
      >
        <summary>任务与会话</summary>
        <Heading size="2" mt="6" mb="3">
          运行状态
        </Heading>
        <Text size="2" color="gray">
          待处理 {state?.counts?.inbox ?? 0}
        </Text>
        <Text as="div" size="1" color="gray">
          累计输出 {botUsage.output} token
        </Text>
        {inspectTask && (
          <div className="inspected-task">
            <Text size="2">这条任务的运行记录</Text>
            {(data.turns || [])
              .filter((t) => t.inputIds.includes(inspectTask))
              .map((t) => (
                <div key={t.id}>
                  <Text size="1">
                    {labels[t.status] || t.status} ·{" "}
                    {t.startedAt ? time(t.startedAt) : "尚未开始"}
                  </Text>
                  <code>{t.id}</code>
                </div>
              ))}
          </div>
        )}
        <Heading size="2" mt="5" mb="3">
          会话
        </Heading>
        {(data.threads || [])
          .filter((t) => t.botId === selected)
          .map((t) => (
            <Flex key={t.id} gap="2" align="center" wrap="wrap">
              <Text size="1">
                {t.scope.channelId || "私聊"} ·{" "}
                {t.status === "loaded"
                  ? "已加载"
                  : t.status === "archived"
                    ? "已归档"
                    : "已存储"}
              </Text>
              <Button
                size="1"
                variant="ghost"
                onClick={async () => {
                  try {
                    if (t.status === "loaded") {
                      const result = await api.thread.unload({
                        threadId: t.id,
                      });
                      if (!result.unloaded)
                        setNotice(
                          "当前会话仍有工作：" + result.blockedBy.join("、"),
                        );
                    } else
                      await api.thread[
                        t.status === "archived" ? "unarchive" : "archive"
                      ]({ threadId: t.id });
                  } catch (e) {
                    setNotice(errorText(e));
                  }
                }}
              >
                {t.status === "loaded"
                  ? "卸载"
                  : t.status === "archived"
                    ? "恢复"
                    : "归档"}
              </Button>
            </Flex>
          ))}
        <Heading size="2" mt="5" mb="3">
          工具任务
        </Heading>
        {(data.jobs || [])
          .filter((j) => j.botId === selected)
          .map((j) => (
            <div className="routine" key={j.id}>
              <Text size="2">
                {j.tool} · {labels[j.state] || j.state}
              </Text>
              <Button
                size="1"
                variant="ghost"
                onClick={async () => {
                  try {
                    const v = await mutate(
                      api.job.read({
                        jobId: j.id,
                      }),
                    );
                    setResult(JSON.stringify(v, null, 2));
                  } catch (e) {
                    setNotice(errorText(e));
                  }
                }}
              >
                查看结果
              </Button>
            </div>
          ))}
        {(state?.questions || []).map((q) => (
          <div className="routine" key={q.id}>
            <Text>{q.text || q.question}</Text>
            <TextField.Root
              placeholder="回答"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
            <Button
              size="1"
              onClick={() =>
                mutate(
                  api.request.resolve({
                    requestId: "req_question:" + q.id,
                    response: { text: answer },
                  }),
                )
                  .then(() => setAnswer(""))
                  .catch((e) => setNotice(errorText(e)))
              }
            >
              提交回答
            </Button>
          </div>
        ))}
      </details>
    </>
  );
  const groupInspector = (
    <>
      <div className="profile">
        <GroupAvatar members={groupBots} size={80} />
        <Heading size="4">{group?.name}</Heading>
        <Text size="2" color="gray">
          {groupBots.length} 位成员
        </Text>
      </div>
      <Text as="p" size="2" color="gray">
        群消息所有成员可见，可用 @ 点名或 @全体成员。
      </Text>
      {groupBots.map((b) => (
        <button
          className="bot"
          key={b.id}
          onClick={() => {
            chooseConversation({ kind: "bot", id: b.id });
          }}
        >
          <BotAvatar id={b.id} name={b.name} activity={activity(b.id)} />
          <Text>{b.name}</Text>
        </button>
      ))}
    </>
  );
  const detailContent = (
    <>
      <div className="details-top">
        <IconButton
          variant="ghost"
          color="gray"
          aria-label="关闭详情"
          onClick={() => setDetails(false)}
        >
          <X size={19} />
        </IconButton>
      </div>
      {view === "group" ? (
        groupInspector
      ) : (
        <>
          <div className="profile">
            <button
              className="edit-avatar"
              aria-label="编辑 bot 头像"
              onClick={() => {
                setDetails(false);
                setAvatarOpen(true);
              }}
            >
              <BotAvatar
                id={bot?.id}
                name={bot?.name}
                size={88}
                activity={activity(selected)}
                animated
              />
              <span>编辑头像</span>
            </button>
            <Heading size="4">{bot?.name}</Heading>
            <Text color="gray" size="2">
              {bot?.description || "你的工作伙伴"}
            </Text>
          </div>
          <Tabs.Root defaultValue="details" key={selected}>
            <Tabs.List>
              <Tabs.Trigger value="details">详情</Tabs.Trigger>
              <Tabs.Trigger value="computer">电脑</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="details">{inspector}</Tabs.Content>
            <Tabs.Content value="computer">
              <DesktopPanel
                botId={selected}
                name={bot?.name || "Bot"}
                enabled={data.desktop}
                baseUrl={activeRuntime?.baseUrl || ""}
                registerBeforeSwitch={runtime.registerBeforeSwitch}
                api={(path, body) =>
                  api.desktop[path.endsWith("/bind") ? "bind" : "control"](body)
                }
              />
            </Tabs.Content>
          </Tabs.Root>
        </>
      )}
    </>
  );
  return React.createElement(
    AvatarContext.Provider,
    { value: { baseUrl: activeRuntime?.baseUrl || "", bots: data.bots } },
    <Theme
      className="app-theme"
      appearance="dark"
      accentColor="amber"
      grayColor="sand"
      radius="large"
    >
      <SidebarProvider
        className="app"
        data-phone={phone}
        data-native-titlebar={nativeMac}
        data-phone-page={navigation.route.page}
        open={true}
        style={{ "--sidebar-width": `${sidebarWidth}px` }}
      >
        {nativeMac && <div className="native-titlebar" data-tauri-drag-region aria-hidden="true" />}
        <MessengerSidebar
          data={data}
          width={sidebarWidth}
          phone={phone}
          onResize={resizeSidebar}
          onSearch={() => setSearchOpen(true)}
          selected={selected}
          groupId={groupId}
          view={view}
          error={connectionError}
          onSelect={chooseConversation}
          onNewBot={() => {
            setNotice("");
            setName("");
            setAdding(true);
          }}
          onNewGroup={() => {
            setNotice("");
            setName("");
            setMembers([]);
            setNewGroup(true);
          }}
          onSettings={() => setPiSettingsOpen(true)}
          runtime={runtime}
        />
        <SearchDialog
          open={searchOpen}
          onOpenChange={setSearchOpen}
          data={data}
          onSelect={(row) => {
            if (row.kind === "message") {
              chooseConversation(row.owner);
              setSearchTarget(row.id);
            } else if (["bot", "group"].includes(row.kind))
              chooseConversation(row);
            else if (["schedule", "monitor"].includes(row.kind)) {
              chooseConversation({ kind: "bot", id: row.botId });
              setDetails(true);
            } else if (row.id === "settings") setPiSettingsOpen(true);
            else if (row.id === "new-bot") {
              setName("");
              setAdding(true);
            } else if (row.id === "new-group") {
              setName("");
              setMembers([]);
              setNewGroup(true);
            } else if (row.id === "requests") setView("requests");
          }}
        />
        <main className="main" style={{ "--outgoing-background": outgoingPalette.background, "--outgoing-foreground": outgoingPalette.foreground }}>
          <header className="header">
            {(phone || privateFrom) && <button className={phone ? "sidebar-toggle phone-back" : "private-return"} aria-label={privateFrom ? "返回群聊" : "返回会话列表"} onClick={() => { composer.current?.blur(); navigation.back(); }}><ChevronLeft size={22} /></button>}
            <button
              className="conversation-identity"
              onClick={() => setDetails((v) => !v)}
              disabled={!bot && !group}
              aria-label="打开会话详情"
            >
              {view === "chat" ? (
                <BotAvatar
                  id={bot?.id}
                  name={bot?.name}
                  size={28}
                  activity={activity(selected)}
                  animated
                />
              ) : view === "group" ? (
                <GroupAvatar members={groupBots} size={28} />
              ) : null}
              <Heading size="3">{title || "Pi Bot"}</Heading>
            </button>
            {routineView && (
              <Button
                size="2"
                disabled={!selected}
                onClick={() => openRoutine(kind)}
              >
                <Plus size={16} />
                新建
              </Button>
            )}
          </header>
          <ConnectionFeedback phase={connectionPhase} onSettings={() => setPiSettingsOpen(true)} />
          {data.configuration?.setupRequired && !connectionError && (
            <ServiceNotice
              kind="setup"
              action={
                <button onClick={() => setPiSettingsOpen(true)}>
                  登录与选择模型
                </button>
              }
            >
              配置 Pi 后即可开始聊天。
            </ServiceNotice>
          )}
          {data.trigger?.halted && !connectionError && (
            <ServiceNotice
              kind="failure"
              action={
                <button onClick={() => setServiceDetails(true)}>
                  查看状态
                </button>
              }
            >
              消息投递已暂停，排队消息已保留。
            </ServiceNotice>
          )}
          <Notification
            text={adding || newGroup || routineKind ? "" : notice}
            onClose={() => setNotice("")}
          />
          {view === "requests" ? (
            <section className="routine-page">
              <Heading size="4" mb="4">
                待处理
              </Heading>
              {(data.requests || [])
                .filter((r) => r.status === "pending")
                .map((r) => (
                  <div className="routine" key={r.id}>
                    <Text weight="medium">
                      {botName(r.botId)} ·{" "}
                      {r.kind === "approval"
                        ? "工具审批"
                        : r.kind === "question"
                          ? "需要回答"
                          : "凭据输入"}
                    </Text>
                    <Text size="2">
                      {r.params.text || r.params.label || r.params.tool}
                    </Text>
                    {r.kind === "approval" && (
                      <>
                        <pre
                          style={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                          }}
                        >
                          {JSON.stringify(r.params.args, null, 2)}
                        </pre>
                        <Flex gap="3">
                          <Button
                            onClick={() =>
                              api.request
                                .resolve({
                                  requestId: r.id,
                                  response: { decision: "approve" },
                                })
                                .catch((e) => setNotice(errorText(e)))
                            }
                          >
                            允许
                          </Button>
                          <Button
                            color="red"
                            variant="soft"
                            onClick={() =>
                              api.request
                                .resolve({
                                  requestId: r.id,
                                  response: { decision: "deny" },
                                })
                                .catch((e) => setNotice(errorText(e)))
                            }
                          >
                            拒绝
                          </Button>
                        </Flex>
                      </>
                    )}
                    {r.kind === "question" && (
                      <>
                        <TextField.Root
                          aria-label="回答待处理问题"
                          value={answer}
                          onChange={(e) => setAnswer(e.target.value)}
                        />
                        <Button
                          disabled={!answer.trim()}
                          onClick={() =>
                            api.request
                              .resolve({
                                requestId: r.id,
                                response: { text: answer },
                              })
                              .then(() => setAnswer(""))
                              .catch((e) => setNotice(errorText(e)))
                          }
                        >
                          回答
                        </Button>
                      </>
                    )}
                    {r.kind === "credential" && r.params.formUrl && (
                      <a
                        href={(activeRuntime?.baseUrl || "") + r.params.formUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        安全输入凭据
                      </a>
                    )}
                  </div>
                ))}
              {!(data.requests || []).some((r) => r.status === "pending") && (
                <Text color="gray">没有待处理请求</Text>
              )}
            </section>
          ) : routineView ? (
            <section className="routine-page">
              <Flex gap="3" align="center" wrap="wrap">
                <Text size="2">所属 bot</Text>
                <Picker
                  label="查看 bot 的任务"
                  value={selected}
                  onChange={setSelected}
                  items={data.bots}
                />
              </Flex>
              <Text as="p" size="2" color="gray">
                {kind === "schedule"
                  ? `${bot?.name || "当前 bot"} 的定时任务，时间按上海时区显示。`
                  : `${bot?.name || "当前 bot"} 的文件变化监控，先试运行再启用。`}
              </Text>
              <div className="routine-list">
                {routineRows.length ? (
                  routineRows.map((r) => routineCard(kind, r))
                ) : (
                  <div className="empty">
                    <Heading size="4">
                      暂无{kind === "schedule" ? "定时任务" : "监控"}
                    </Heading>
                    <Button
                      disabled={!selected}
                      onClick={() => openRoutine(kind)}
                    >
                      创建第一个{kind === "schedule" ? "定时任务" : "监控"}
                    </Button>
                  </div>
                )}
              </div>
            </section>
          ) : (
            <>
              {view === "group" && (
                <div className="view-toolbar group-toolbar">
                  <Text size="2" color="gray">
                    {groupBots.map((b) => b.name).join("、")}
                  </Text>
                </div>
              )}
              {view === "peers" && (
                <div className="view-toolbar">
                  <Flex gap="2" align="center" wrap="wrap">
                    <Picker
                      label="发起 bot"
                      value={peerA}
                      onChange={setPeerA}
                      items={data.bots}
                    />
                    <Text>⇄</Text>
                    <Picker
                      label="协作 bot"
                      value={peerB}
                      onChange={setPeerB}
                      items={data.bots}
                    />
                    <Picker
                      label="对话范围"
                      value={peerScope}
                      onChange={setPeerScope}
                      items={[
                        {
                          id: "direct",
                          name: "直接协作",
                        },
                        ...data.groups,
                      ]}
                    />
                  </Flex>
                  <Text size="1" color="gray">
                    查看两个 bot 的实际协作记录，也可发起新任务。
                  </Text>
                </div>
              )}
              <section
                ref={conversation}
                className={
                  "conversation " + (view === "chat" ? "private-chat" : "")
                }
                aria-label="聊天消息"
                onScroll={() => {
                  const el = conversation.current;
                  const bottom =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                  pinnedToEnd.current = bottom;
                  setAtBottom(bottom);
                  scrollPositions.current.set(lastScope.current, { top: el.scrollTop, bottom });
                }}
              >
                <ConversationRequests data={data} kind={view === "group" ? "group" : "bot"} id={view === "group" ? groupId : selected} api={api} baseUrl={activeRuntime?.baseUrl || ""} />
                {laidOutMessages.length ? (
                  laidOutMessages.map(({ message: m, separator, sender, runStart, runEnd, time: messageTime }) => (
                    <React.Fragment key={m.direction + m.messageId}>
                      {separator && <div className="date-divider"><time dateTime={messageTime.iso} title={messageTime.full} aria-label={messageTime.full}>{messageTime.label}</time></div>}
                      <div data-message-id={m.messageId} className={"row " + (isUserMessage(m) ? "user " : "") + (sender ? "group-incoming" : "")} data-run-start={runStart || undefined} data-run-end={runEnd || undefined}>
                        <time className="message-time-accessible" dateTime={messageTime.iso}>{messageTime.full}</time>
                        {sender && <div className="group-sender-avatar">{runEnd && <button className="group-avatar-button" aria-label={sender.bot ? `与 ${sender.name} 私聊` : `${sender.name}，私聊不可用`} aria-disabled={!sender.bot || undefined} title={sender.bot ? `与 ${sender.name} 私聊` : "该成员已不可用"} onClick={() => openSenderConversation(sender.bot?.id)}><span aria-hidden="true"><BotAvatar id={sender.id} name={sender.name} size={28} activity="idle" avatar={sender.bot?.avatar ?? null} /></span></button>}</div>}
                        <div className={sender ? "group-message-content" : "message-content"}>
                          {sender && runStart && <div className="group-sender-name"><span style={{ "--sender-color": senderLabelColor(sender.id, sender.bot?.avatar) }}>{sender.name}</span></div>}
                          {view === "peers" && <div className="peer-sender-name">{isUserMessage(m) ? "你" : botName(m.sender)}</div>}
                          <div className="bubble">
                          <MessageBody text={displayText(m)} />

                          {["queued", "processing"].includes(m.status) && (
                            <Text size="1" className="status">
                              {labels[m.status] || m.status}
                            </Text>
                          )}
                          {messageFailures(data, m).map((failed) => (
                            <TaskFailure
                              key={failed.messageId}
                              message={failed}
                              owner={
                                view === "group"
                                  ? botName(failed.botId)
                                  : undefined
                              }
                              api={api}
                              onInspect={() => {
                                if (view === "group") {
                                  chooseConversation({ kind: "bot", id: failed.botId });
                                }
                                setInspectTask(failed.messageId);
                                setRuntimeDetailsOpen(true);
                                setDetails(true);
                              }}
                            />
                          ))}
                          </div>
                        </div>
                      </div>
                    </React.Fragment>
                  ))
                ) : (
                  <div className="empty">
                    <Heading size="5">
                      {view === "peers" ? "暂无 bot 对话" : "准备开始"}
                    </Heading>
                    <Text color="gray" size="2">
                      {view === "peers"
                        ? "选择两个 bot，发起一项真实协作任务。"
                        : "发一条消息，开始处理任务。"}
                    </Text>
                  </div>
                )}
                <div ref={end} />
              </section>
              <div className="composer-area">
                {sendFailure && <div className="send-failure" role="status"><p>{sendFailure.draft}</p><span>{sendFailure.message}</span>{!sendFailure.uncertain && <button disabled={busy || connectionPhase !== "ready"} onClick={() => send(true)}>重试发送</button>}{sendFailure.uncertain && <button onClick={() => setServiceDetails(true)}>查看状态</button>}</div>}
                {!atBottom && (
                  <Button
                    className="scroll-latest"
                    variant="soft"
                    color="gray"
                    onClick={scrollBottom}
                  >
                    <ChevronDown size={17} />
                    最新消息
                  </Button>
                )}
                {view === "chat" && activity(selected) !== "idle" && (
                  <div className="activity-line" role="status" data-activity={activity(selected)}>
                    <BotAvatar
                      id={selected}
                      name={bot?.name}
                      activity={activity(selected)}
                      size={22}
                      animated
                    />
                    <Text size="2" color="gray">
                      {activityLabels[activity(selected)]}
                    </Text>
                  </div>
                )}
                {mentionOptions.length > 0 && (
                  <div
                    className="mention-menu"
                    role="listbox"
                    aria-label="选择 @ 成员"
                  >
                    {mentionOptions.map((name, i) => (
                      <button
                        key={name}
                        className={i === mentionIndex ? "active" : ""}
                        onClick={() => chooseMention(name)}
                      >
                        {name === "全体成员" ? "@全体成员" : "@" + name}
                      </button>
                    ))}
                  </div>
                )}
                <div className="composer">
                  <ComposerTextarea
                    className="message-input"
                    data-gramm="false"
                    data-gramm_editor="false"
                    data-enable-grammarly="false"
                    ref={composer}
                    aria-label="消息"
                    placeholder={
                      view === "peers"
                        ? "交给这两个 bot 的协作任务…"
                        : view === "group"
                          ? `发到 ${group?.name}…`
                          : `给 ${bot?.name || "bot"} 发消息…`
                    }
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setMentionIndex(0);
                      setHideMentions(false);
                    }}
                    rows={1}
                    onKeyDown={(e) => {
                      if (mentionOptions.length) {
                        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                          e.preventDefault();
                          setMentionIndex(
                            (i) =>
                              (i +
                                (e.key === "ArrowDown" ? 1 : -1) +
                                mentionOptions.length) %
                              mentionOptions.length,
                          );
                          return;
                        }
                        if (e.key === "Escape") {
                          setHideMentions(true);
                          return;
                        }
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          chooseMention(mentionOptions[mentionIndex]);
                          return;
                        }
                      }
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        send();
                      }
                    }}
                  />
                  <Button
                    disabled={
                      !api ||
                      connectionPhase !== "ready" ||
                      busy ||
                      !draft.trim() ||
                      !!connectionError ||
                      data.configuration?.setupRequired
                    }
                    onClick={() => send()}
                    aria-label={view === "peers" ? "发起协作" : "发送"}
                    className="send-button"
                  >
                    {busy ? "…" : <ArrowUp size={20} />}
                  </Button>
                </div>
              </div>
            </>
          )}
        </main>
        {details && wide && ["chat", "group"].includes(view) && (
          <aside className="inspector" aria-label="会话详情">
            {detailContent}
          </aside>
        )}
        <Dialog.Root
          open={!!routineKind}
          onOpenChange={(v) => {
            if (!v) setRoutineKind("");
          }}
        >
          <Dialog.Content maxWidth="440px">
            <Dialog.Title>
              {routineKind === "schedule" ? "新建定时任务" : "新建监控"}
            </Dialog.Title>
            <Dialog.Description size="2" mb="4">
              {routineKind === "schedule"
                ? "选择负责 bot、任务和执行时间。"
                : "监控仓库内的文件变化；试运行通过后启用。"}
            </Dialog.Description>
            <Flex direction="column" gap="3">
              {notice && (
                <Text size="2" color="red">
                  {notice}
                </Text>
              )}
              <Picker
                label="负责 bot"
                value={routineOwner}
                onChange={(v) => {
                  setRoutineOwner(v);
                  setRoutineGroup("direct");
                }}
                items={data.bots}
              />
              <Picker
                label="回复到"
                value={routineGroup}
                onChange={setRoutineGroup}
                items={[
                  {
                    id: "direct",
                    name: "回复到 bot 私聊",
                  },
                  ...data.groups.filter((g) =>
                    g.memberIds.includes(routineOwner),
                  ),
                ]}
              />
              <TextArea
                aria-label="任务内容"
                placeholder="任务内容"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <Flex gap="2">
                <Button
                  size="1"
                  variant="soft"
                  onClick={() =>
                    setWhen(
                      new Date(Date.now() + 120000)
                        .toLocaleString("sv-SE", {
                          timeZone: "Asia/Shanghai",
                        })
                        .replace(" ", "T")
                        .slice(0, 16),
                    )
                  }
                >
                  2 分钟后
                </Button>
                <Button
                  size="1"
                  variant="soft"
                  onClick={() =>
                    setWhen(
                      new Date(Date.now() + 3600000)
                        .toLocaleString("sv-SE", {
                          timeZone: "Asia/Shanghai",
                        })
                        .replace(" ", "T")
                        .slice(0, 16),
                    )
                  }
                >
                  1 小时后
                </Button>
              </Flex>
              <label>
                <Text size="2">
                  {routineKind === "schedule" ? "首次执行时间" : "监控截止时间"}
                  （上海）
                </Text>
                <TextField.Root
                  aria-label="执行时间"
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                />
              </label>
              <label>
                <Text size="2">
                  {routineKind === "schedule"
                    ? "重复间隔（分钟，留空仅一次）"
                    : "检查间隔（分钟）"}
                </Text>
                <TextField.Root
                  aria-label="间隔分钟"
                  type="number"
                  min="1"
                  value={interval}
                  onChange={(e) => setIntervalMinutes(e.target.value)}
                />
              </label>
              {routineKind === "monitor" && (
                <label>
                  <Text size="2">监控文件（仓库内路径）</Text>
                  <TextField.Root
                    aria-label="监控文件"
                    placeholder={data.watchFile}
                    value={watchPath}
                    onChange={(e) => setWatchPath(e.target.value)}
                  />
                </label>
              )}
              <Flex gap="3" justify="end">
                <Dialog.Close>
                  <Button variant="soft" color="gray">
                    返回
                  </Button>
                </Dialog.Close>
                <Button
                  disabled={busy || !routineOwner || !prompt.trim()}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const at = Date.parse(when + ":00+08:00");
                      if (!Number.isFinite(at)) throw Error("请选择有效时间");
                      await mutate(
                        api.routine.create({
                          botId: routineOwner,
                          kind: routineKind,
                          prompt,
                          groupId:
                            routineGroup === "direct"
                              ? undefined
                              : routineGroup,
                          ...(routineKind === "schedule"
                            ? {
                                at,
                                timezone: "Asia/Shanghai",
                                intervalMs: interval
                                  ? Number(interval) * 60000
                                  : undefined,
                              }
                            : {
                                deadline: at,
                                intervalMs: interval
                                  ? Number(interval) * 60000
                                  : 60000,
                                filePath: watchPath || undefined,
                              }),
                        }),
                      );
                      setSelected(routineOwner);
                      setRoutineKind("");
                      setPrompt("");
                      setWhen("");
                      setIntervalMinutes("");
                      setWatchPath("");
                      setNotice("");
                    } catch (e) {
                      setNotice(errorText(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  创建
                </Button>
              </Flex>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>
        <Dialog.Root open={newGroup} onOpenChange={setNewGroup}>
          <Dialog.Content maxWidth="400px">
            <Dialog.Title>新建群聊</Dialog.Title>
            <Dialog.Description size="2" mb="4">
              至少选择两个 bot；同一 bot 可加入多个群。群消息所有成员可见，输入
              @ 点名或 @全体成员。
            </Dialog.Description>
            <Flex direction="column" gap="3">
              <TextField.Root
                aria-label="群名称"
                placeholder="群名称"
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              {data.bots.map((b) => (
                <label key={b.id}>
                  <Flex gap="2" align="center">
                    <Checkbox
                      checked={members.includes(b.id)}
                      onCheckedChange={(checked) =>
                        setMembers((s) =>
                          checked
                            ? [...s, b.id]
                            : s.filter((id) => id !== b.id),
                        )
                      }
                    />
                    <Text size="2">{b.name}</Text>
                  </Flex>
                </label>
              ))}
              {notice && (
                <Text color="red" size="2">
                  {notice}
                </Text>
              )}
              <Flex justify="end" gap="3">
                <Dialog.Close>
                  <Button variant="soft">返回</Button>
                </Dialog.Close>
                <Button
                  disabled={busy || members.length < 2 || !name.trim()}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const { group: g } = await mutate(
                        api.group.create({
                          name,
                          memberIds: members,
                        }),
                      );
                      navigation.list();
                      setGroupId(g.id);
                      setGroupTarget(g.memberIds[0]);
                      setSelected(g.memberIds[0]);
                      setView("group");
                      setNewGroup(false);
                      setName("");
                      setNotice("");
                    } catch (e) {
                      setNotice(errorText(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  创建群聊
                </Button>
              </Flex>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>
        <Dialog.Root
          open={!!result}
          onOpenChange={(v) => {
            if (!v) setResult("");
          }}
        >
          <Dialog.Content>
            <Dialog.Title>任务结果</Dialog.Title>
            <Dialog.Description>
              持久工具结果，最多显示首 4096 字。
            </Dialog.Description>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {result}
            </pre>
            <Dialog.Close>
              <Button>关闭</Button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Root>
        <Dialog.Root
          open={details && (!wide || !["chat", "group"].includes(view))}
          onOpenChange={setDetails}
        >
          <Dialog.Content className="details-dialog" maxWidth="460px">
            <Dialog.Title className="sr-only">会话详情</Dialog.Title>
            <Dialog.Description className="sr-only">
              Bot 任务、运行状态和电脑
            </Dialog.Description>
            {detailContent}
          </Dialog.Content>
        </Dialog.Root>
        <Dialog.Root
          open={adding}
          onOpenChange={(v) => {
            setAdding(v);
            setNotice("");
          }}
        >
          <Dialog.Content maxWidth="380px">
            <Dialog.Title>新建 bot</Dialog.Title>
            <Dialog.Description size="2" mb="4">
              给助手取个名字。
            </Dialog.Description>
            <TextField.Root
              aria-label="名称"
              placeholder="名称"
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {notice && (
              <Text size="2" color="red" role="alert">
                {notice}
              </Text>
            )}
            <Flex gap="3" justify="end" mt="5">
              <Dialog.Close>
                <Button variant="soft">取消</Button>
              </Dialog.Close>
              <Button
                onClick={async () => {
                  try {
                    const { bot: b } = await mutate(
                      api.bot.create({
                        name,
                      }),
                    );
                    navigation.list();
                    setSelected(b.id);
                    setView("chat");
                    setName("");
                    setAdding(false);
                  } catch (e) {
                    setNotice(errorText(e));
                  }
                }}
              >
                创建
              </Button>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>
        <AvatarEditor
          open={avatarOpen}
          onOpenChange={setAvatarOpen}
          bot={bot}
          api={api}
        />
        <Dialog.Root open={serviceDetails} onOpenChange={setServiceDetails}>
          <Dialog.Content maxWidth="420px">
            <Dialog.Title>服务状态</Dialog.Title>
            <Dialog.Description>
              消息仍然保存在服务端。修复服务的投递问题后，可以继续处理。
            </Dialog.Description>
            <Flex direction="column" gap="3" mt="4">
              <Text>连接：{connectionError ? "正在重连" : "已连接"}</Text>
              <Text>消息投递：{data.trigger?.halted ? "已暂停" : "正常"}</Text>
              <Text>排队消息：{data.trigger?.queued ?? 0}</Text>
              <Text size="1" color="gray">
                定位信息：{data.seq ?? 0} · {data.status}
              </Text>
              <Dialog.Close>
                <Button variant="soft">关闭</Button>
              </Dialog.Close>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>
      </SidebarProvider>
    </Theme>,
  );
}

function RuntimeShell() {
  const runtime = useRuntime();
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <>
      <App
        key={runtime.status.active?.id || "disconnected"}
        runtime={runtime}
        setPiSettingsOpen={setSettingsOpen}
      />
      <Theme
        className="overlay-theme"
        appearance="dark"
        accentColor="amber"
        grayColor="sand"
        radius="large"
      >
        <SettingsPage
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          runtime={runtime}
        />
      </Theme>
    </>
  );
}
createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <RuntimeShell />
  </ErrorBoundary>,
);
