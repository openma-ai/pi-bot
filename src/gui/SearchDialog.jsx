import React, { useState, useEffect } from "react";
import { Command } from "cmdk";
import { Search, MessageSquare, Clock3, Radar, Settings2 } from "lucide-react";
import { Dialog } from "@radix-ui/themes";
import { searchEverything } from "./presentation.ts";
import { BotAvatar, GroupAvatar } from "./BotAvatar.jsx";
export function SearchDialog({ open, onOpenChange, data, onSelect }) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  const rows = searchEverything(data, query);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
      }}
    >
      <Dialog.Content className="search-dialog" aria-describedby={undefined}>
        <Dialog.Title className="sr-only">搜索全部</Dialog.Title>
        <Command shouldFilter={false} label="搜索全部">
          <div className="search-command-input">
            <Search size={19} />
            <Command.Input
              placeholder="搜索会话、消息、定时任务、监控…"
              value={query}
              onValueChange={setQuery}
            />
            <kbd>Esc</kbd>
          </div>
          <Command.List>
            <Command.Empty>没有找到结果</Command.Empty>
            {["bot", "group", "message", "schedule", "monitor", "action"].map(
              (kind) => {
                const matches = rows.filter((r) => r.kind === kind);
                return matches.length ? (
                  <Command.Group
                    key={kind}
                    heading={
                      {
                        bot: "助手",
                        group: "群聊",
                        message: "消息",
                        schedule: "定时任务",
                        monitor: "监控",
                        action: "功能",
                      }[kind]
                    }
                  >
                    {matches.map((r) => (
                      <Command.Item
                        key={kind + r.id}
                        value={kind + r.id}
                        onSelect={() => {
                          onSelect(r);
                          onOpenChange(false);
                        }}
                      >
                        {kind === "bot" ? (
                          <BotAvatar id={r.id} name={r.name} size={28} />
                        ) : kind === "group" ? (
                          <GroupAvatar
                            members={(data.bots ?? []).filter((b) =>
                              r.group.memberIds.includes(b.id),
                            )}
                            size={28}
                          />
                        ) : kind === "schedule" ? (
                          <Clock3 size={18} />
                        ) : kind === "monitor" ? (
                          <Radar size={18} />
                        ) : kind === "message" ? (
                          <MessageSquare size={18} />
                        ) : (
                          <Settings2 size={18} />
                        )}
                        <span className="search-result-label">
                          <span>{r.name}</span>
                          {r.subtitle && <small>{r.subtitle}</small>}
                        </span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                ) : null;
              },
            )}
          </Command.List>
          <div className="search-command-footer">
            ↑ ↓ 选择 <span>↵ 打开</span>
          </div>
        </Command>
      </Dialog.Content>
    </Dialog.Root>
  );
}
