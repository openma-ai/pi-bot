import React from "react";
import {PiboBrand} from "./PiboBrand.jsx";
import { Plus, Search, Settings2 } from "lucide-react";
import { DropdownMenu, ScrollArea, HoverCard, ContextMenu } from "@radix-ui/themes";
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
function ConversationHint({ compact, row, pinned, onToggle, children }) {
  const suppressClick = React.useRef(false);
  const touch = React.useRef(false);
  const trigger = React.cloneElement(children, {
    onKeyDown: (event) => {
      children.props.onKeyDown?.(event);
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        touch.current = false;
        const rect = event.currentTarget.getBoundingClientRect();
        event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.bottom }));
      }
    },
    onClickCapture: (event) => {
      if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; }
    },
    onPointerDown: (event) => { touch.current = event.pointerType === "touch" || event.pointerType === "pen"; suppressClick.current = false; },
    "aria-haspopup": "menu",
    "aria-keyshortcuts": "Shift+F10 ContextMenu",
  });
  const menuTrigger = <ContextMenu.Trigger>{trigger}</ContextMenu.Trigger>;
  return <ContextMenu.Root onOpenChange={(open) => { if (open) suppressClick.current = touch.current; }}>
    {compact ? <HoverCard.Root><HoverCard.Trigger>{menuTrigger}</HoverCard.Trigger><HoverCard.Content side="right" className="conversation-hover"><strong>{row.name}</strong><p>{row.preview}</p>{row.pending > 0 && <small>需处理 {row.pending}</small>}</HoverCard.Content></HoverCard.Root> : menuTrigger}
    <ContextMenu.Content aria-label={`${row.name} 会话操作`}><ContextMenu.Item onSelect={onToggle}>{pinned ? "取消置顶" : "置顶会话"}</ContextMenu.Item></ContextMenu.Content>
  </ContextMenu.Root>;
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
  workspaceScope,
  online = true,
  connectionNotice,
  connectionStart,
}) {
  const { setOpenMobile } = useSidebar();
  const rows = conversationList(data).map((row) => ({ ...row, pending: requestsForConversation(data, row.kind, row.id).length }));
  const compact = !phone && width < 156;
  const pins = usePinnedConversations(workspaceScope || runtime?.status?.active?.scope || "disconnected");
  const pinned = rows.filter((row) => pins.keys.includes(conversationKey(row)));
  return (
    <Sidebar
      className="messenger-sidebar"
      collapsible="none"
      aria-label="会话导航"
      data-compact={compact}
    >
      {!compact && <>
      <SidebarHeader className="messenger-sidebar-header">
        <div className="sidebar-toolbar">
          <span className="sidebar-brand"><PiboBrand/></span>
          {phone && <button className="toolbar-profile" aria-label="设置" title="设置" onClick={onSettings}><Settings2 size={20}/></button>}
          <button className="toolbar-search" aria-label="搜索全部（⌘K）" title="搜索全部（⌘K）" onClick={onSearch}><Search size={20} /></button>
          <DropdownMenu.Root><DropdownMenu.Trigger><Button size="icon" variant="ghost" aria-label="新建会话" title="新建会话"><Plus size={21} /></Button></DropdownMenu.Trigger><DropdownMenu.Content><DropdownMenu.Item onSelect={onNewBot}>新建 bot</DropdownMenu.Item><DropdownMenu.Item onSelect={onNewGroup}>新建群聊</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Root>
        </div>
        <div className="sidebar-heading"><strong>会话</strong>{connectionNotice || <span>{rows.length} 个伙伴</span>}</div>
      </SidebarHeader>
      </>}
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
          {connectionStart}
          {pinned.length > 0 && <><div className="pinned-conversations" aria-label="置顶会话">
            {pinned.map((row) => <div className="pinned-item" key={conversationKey(row)}>
              <ConversationHint compact={compact} row={row} pinned onToggle={() => pins.toggle(row)}><button className="pinned-conversation" aria-label={`置顶 ${row.name}${row.pending ? ` · 需处理 ${row.pending}` : ""}`} aria-current={(row.kind === "bot" ? selected === row.id && view === "chat" : groupId === row.id && view === "group") ? "page" : undefined} onClick={() => { onSelect(row); setOpenMobile(false); }}>
                {row.kind === "bot" ? <BotAvatar id={row.id} name={row.name} size={compact ? 36 : 88} activity={botActivity(data, row.id)} /> : <GroupAvatar size={compact ? 36 : phone ? 76 : 88} members={data.bots.filter((bot) => row.group.memberIds.includes(bot.id))} />}
                <span className="pinned-name">{row.name}</span>{row.pending > 0 && <span className="rail-pending">{row.pending}</span>}
              </button></ConversationHint>
            </div>)}
          </div></>}
          <SidebarMenu aria-label="会话列表">
            {rows.filter((row) => !pins.keys.includes(conversationKey(row))).map((row) => (
              <SidebarMenuItem key={row.kind + row.id}>
                <ConversationHint compact={compact} row={row} onToggle={() => pins.toggle(row)}>
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
                      size={compact ? 32 : phone ? 44 : 52}
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
                    <span className="contact-heading"><span className="contact-name">{row.name}</span>{phone && <time dateTime={new Date(row.updatedAt).toISOString()}>{new Date(row.updatedAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</time>}</span>
                    {row.pending > 0 && <span className="pending-count">需处理 {row.pending}</span>}
                    <span className="preview">{row.preview}</span>
                  </span>
                </SidebarMenuButton>
                </ConversationHint>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
          {!rows.length && !compact && online && (
            <div className="contact-empty"><p>创建一个 bot，开始聊天</p><Button onClick={onNewBot}>新建 bot</Button></div>
          )}
        </ScrollArea>
      </SidebarContent>
      <SidebarFooter className="messenger-sidebar-footer">
        {compact && <>
        <div className="sidebar-toolbar">
          {phone && <button className="toolbar-profile" aria-label="设置" title="设置" onClick={onSettings}><Settings2 size={20}/></button>}
          <button className="toolbar-search" aria-label="搜索全部（⌘K）" title="搜索全部（⌘K）" onClick={onSearch}><Search size={20} /></button>
          <DropdownMenu.Root><DropdownMenu.Trigger><Button size="icon" variant="ghost" aria-label="新建会话" title="新建会话"><Plus size={21} /></Button></DropdownMenu.Trigger><DropdownMenu.Content><DropdownMenu.Item onSelect={onNewBot}>新建 bot</DropdownMenu.Item><DropdownMenu.Item onSelect={onNewGroup}>新建群聊</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Root>
        </div>
        </>}
        <SidebarMenu><SidebarMenuItem><SidebarMenuButton onClick={onSettings} aria-label="设置" title="设置"><Settings2 size={17} /><span>设置</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
      </SidebarFooter>
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-label="调整会话列表宽度，⌘B 切换展开或收起"
        aria-keyshortcuts="Meta+B Control+B"
        aria-orientation="vertical"
        aria-valuemin={76}
        aria-valuemax={520}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(e) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            onResize(
              e.key === "Home"
                ? 76
                : e.key === "End"
                  ? 520
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
