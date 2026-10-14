import React from "react";
import { Plus, Search, Settings2, Pin, PinOff, UserRound } from "lucide-react";
import { DropdownMenu, ScrollArea, HoverCard } from "@radix-ui/themes";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from "./ui/sidebar.jsx";
import { Button } from "./ui/button.jsx";
import { BotAvatar, GroupAvatar } from "./BotAvatar.jsx";
import { botActivity, conversationList } from "./presentation.ts";
import { requestsForConversation } from "./conversation-requests.js";
import { usePinnedConversations, conversationKey } from "./hooks/use-pinned-conversations.js";
function ConversationHint({ compact, row, children }) {
  if (!compact) return children;
  return <HoverCard.Root><HoverCard.Trigger>{children}</HoverCard.Trigger><HoverCard.Content side="right" className="conversation-hover"><strong>{row.name}</strong><p>{row.preview}</p>{row.pending > 0 && <small>需处理 {row.pending}</small>}</HoverCard.Content></HoverCard.Root>;
}

export function MessengerSidebar({
  data,
  width,
  onResize,
  phone,
  onSearch,
  selected,
  groupId,
  view,
  onSelect,
  onNewBot,
  onNewGroup,
  onSettings,
  runtime,
}) {
  const { setOpenMobile } = useSidebar();
  const rows = conversationList(data).map((row) => ({ ...row, pending: requestsForConversation(data, row.kind, row.id).length }));
  const compact = !phone && width < 156;
  const pins = usePinnedConversations(runtime?.status?.active?.scope || "disconnected");
  const pinned = rows.filter((row) => pins.keys.includes(conversationKey(row)));
  return (
    <Sidebar
      className="messenger-sidebar"
      collapsible="none"
      aria-label="会话导航"
      data-compact={compact}
    >
      <SidebarHeader className="messenger-sidebar-header">
        <div className="sidebar-toolbar">
          {phone && <button className="toolbar-profile" aria-label="设置" title="设置" onClick={onSettings}><UserRound size={22} /></button>}
          <button className="toolbar-search" aria-label="搜索全部（⌘K）" title="搜索全部（⌘K）" onClick={onSearch}><Search size={20} /></button>
          <DropdownMenu.Root><DropdownMenu.Trigger><Button size="icon" variant="ghost" aria-label="新建会话" title="新建会话"><Plus size={21} /></Button></DropdownMenu.Trigger><DropdownMenu.Content><DropdownMenu.Item onSelect={onNewBot}>新建 bot</DropdownMenu.Item><DropdownMenu.Item onSelect={onNewGroup}>新建群聊</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Root>
        </div>
      </SidebarHeader>
      <SidebarContent className="conversation-navigation">
        <ScrollArea
          type="scroll"
          scrollHideDelay={750}
          scrollbars="vertical"
          size="1"
          className="conversation-scroll"
          tabIndex={0}
          aria-label="滚动会话列表"
        >
          {pinned.length > 0 && <div className="pinned-conversations" aria-label="置顶会话">
            {pinned.map((row) => <div className="pinned-item" key={conversationKey(row)}>
              <ConversationHint compact={compact} row={row}><button className="pinned-conversation" aria-label={`置顶 ${row.name}${row.pending ? ` · 需处理 ${row.pending}` : ""}`} aria-current={(row.kind === "bot" ? selected === row.id && view === "chat" : groupId === row.id && view === "group") ? "page" : undefined} onClick={() => { onSelect(row); setOpenMobile(false); }}>
                {row.kind === "bot" ? <BotAvatar id={row.id} name={row.name} size={compact ? 36 : 48} activity={botActivity(data, row.id)} /> : <GroupAvatar members={data.bots.filter((bot) => row.group.memberIds.includes(bot.id))} />}
                <span className="pinned-name">{row.name}</span>{row.pending > 0 && <span className="rail-pending">{row.pending}</span>}
              </button></ConversationHint>
              <button className="pin-toggle" aria-label={`取消置顶 ${row.name}`} title="取消置顶" onClick={() => pins.toggle(row)}><PinOff size={13} /></button>
            </div>)}
          </div>}
          <SidebarMenu aria-label="会话列表">
            {rows.filter((row) => !pins.keys.includes(conversationKey(row))).map((row) => (
              <SidebarMenuItem key={row.kind + row.id}>
                <ConversationHint compact={compact} row={row}>
                <SidebarMenuButton
                  size="lg"
                  className="conversation-link"
                  isActive={
                    row.kind === "bot"
                      ? view === "chat" && selected === row.id
                      : view === "group" && groupId === row.id
                  }
                  aria-current={
                    (
                      row.kind === "bot"
                        ? view === "chat" && selected === row.id
                        : view === "group" && groupId === row.id
                    )
                      ? "page"
                      : undefined
                  }
                  aria-label={row.name + (row.pending ? ` · ${row.pending} 项需要你处理的请求` : "")}
                  tooltip={compact ? `${row.name}\n${row.preview}${row.pending ? ` · 需处理 ${row.pending}` : ""}` : undefined}
                  title={compact ? `${row.name} · ${row.preview}` : undefined}
                  onClick={() => {
                    onSelect(row);
                    setOpenMobile(false);
                  }}
                >
                  {row.kind === "bot" ? (
                    <BotAvatar
                      id={row.id}
                      name={row.name}
                      activity={botActivity(data, row.id)}
                    />
                  ) : (
                    <GroupAvatar
                      members={data.bots.filter((b) =>
                        row.group.memberIds.includes(b.id),
                      )}
                    />
                  )}
                  {compact && row.pending > 0 && <span className="rail-pending" aria-hidden="true">{row.pending}</span>}
                  <span className="bot-label">
                    <span className="contact-heading"><span className="contact-name">{row.name}</span><time dateTime={new Date(row.updatedAt).toISOString()}>{new Date(row.updatedAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</time></span>
                    {row.pending > 0 && <span className="pending-count">需处理 {row.pending}</span>}
                    <span className="preview">{row.preview}</span>
                  </span>
                </SidebarMenuButton>
                </ConversationHint>
                <button className="pin-toggle" aria-label={`置顶 ${row.name}`} title="置顶会话" onClick={() => pins.toggle(row)}><Pin size={13} /></button>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
          {!rows.length && !compact && (
            <p className="contact-empty">创建一个 bot，开始聊天</p>
          )}
        </ScrollArea>
      </SidebarContent>
      <SidebarFooter className="messenger-sidebar-footer">
        <SidebarMenu><SidebarMenuItem><SidebarMenuButton onClick={onSettings} aria-label="设置" title="设置"><Settings2 size={17} /><span>设置</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
      </SidebarFooter>
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-label="调整会话列表宽度，⌘B 切换展开或收起"
        aria-keyshortcuts="Meta+B Control+B"
        aria-orientation="vertical"
        aria-valuemin={76}
        aria-valuemax={360}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(e) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            onResize(
              e.key === "Home"
                ? 76
                : e.key === "End"
                  ? 360
                  : width + (e.key === "ArrowLeft" ? -16 : 16),
            );
          }
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.dataset.startX = e.clientX;
          e.currentTarget.dataset.startWidth = width;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            onResize(
              Number(e.currentTarget.dataset.startWidth) +
                e.clientX -
                Number(e.currentTarget.dataset.startX),
            );
        }}
        onLostPointerCapture={() => {
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        }}
        onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      />
    </Sidebar>
  );
}
