import React, {useState} from "react";
import {Select,Popover} from "@radix-ui/themes";
import {Command} from "cmdk";
import {Check,ChevronDown,Search} from "lucide-react";
export function Choice({
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
        value={value || ""}
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
                value={i.id + " " + i.name + " " + (i.detail || "")}
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
