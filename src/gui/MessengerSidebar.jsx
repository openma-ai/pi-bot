import React from "react";
import { Plus, Search, Settings2, Inbox } from "lucide-react";
import { DropdownMenu, ScrollArea } from "@radix-ui/themes";
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

export function MessengerSidebar({
  data,
  width,
  onResize,
  onSearch,
  selected,
  groupId,
  view,
  onSelect,
  onNewBot,
  onNewGroup,
  onRequests,
  onSettings,
  error,
}) {
  const { setOpenMobile } = useSidebar();
  const rows = conversationList(data);
  const pending = (data.requests || []).filter(
    (r) => r.status === "pending",
  ).length;
  const compact = width < 156;
  return (
    <Sidebar
      className="messenger-sidebar"
      aria-label="会话导航"
      data-compact={compact}
    >
      <SidebarHeader className="messenger-sidebar-header">
        <div className="brand">
          <span className="brand-name">Pi Bot</span>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <Button size="icon" variant="ghost" aria-label="新建会话">
                <Plus size={19} />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              <DropdownMenu.Item onSelect={onNewBot}>
                新建 bot
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={onNewGroup}>
                新建群聊
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </div>
        <button
          className="search-launcher"
          aria-label="搜索全部（⌘K）"
          title="搜索全部（⌘K）"
          onClick={onSearch}
        >
          <Search size={17} />
          <span>搜索全部</span>
          <kbd>⌘ K</kbd>
        </button>
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
          <SidebarMenu aria-label="会话列表">
            {rows.map((row) => (
              <SidebarMenuItem key={row.kind + row.id}>
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
                  aria-label={row.name}
                  title={compact ? row.name : undefined}
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
                  <span className="bot-label">
                    <span className="contact-name">{row.name}</span>
                    <span className="preview">{row.preview}</span>
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
          {!rows.length && (
            <p className="contact-empty">创建一个 bot，开始聊天</p>
          )}
        </ScrollArea>
      </SidebarContent>
      <SidebarFooter className="messenger-sidebar-footer">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => {
                onRequests();
                setOpenMobile(false);
              }}
              aria-label="待处理问题"
              title="待处理问题"
            >
              <Inbox size={16} />
              <span>待处理</span>
              {pending > 0 && <span className="pending-count">{pending}</span>}
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={onSettings}
              aria-label="Pi 登录与模型"
              title="Pi 登录与模型"
            >
              <Settings2 size={16} />
              <span>Pi 登录与模型</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="mode">
          <span
            className={
              "connection-dot " +
              (!error && data.status === "ready" ? "connected" : "")
            }
          />
          <span>
            {error ||
              (data.configuration?.setupRequired
                ? "请配置 Pi"
                : data.status === "ready"
                  ? "Pi 已连接"
                  : "连接中")}
          </span>
        </div>
      </SidebarFooter>
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-label="调整会话列表宽度"
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
