import React, { useEffect, useRef, useState } from "react";
import { Dialog, Tabs, Flex, Text, Button, Callout } from "@radix-ui/themes";
import { RadioGroup } from "radix-ui";
import { Shuffle, Upload, RotateCcw, X } from "lucide-react";
import {
  BotAvatar,
  avatarShapes,
  avatarShapeNames,
  avatarColors,
  defaultAvatar,
} from "./BotAvatar.jsx";
const colorNames = [
  "白色",
  "棕色",
  "红色",
  "橙色",
  "黄色",
  "绿色",
  "青色",
  "蓝色",
  "紫色",
  "粉色",
  "灰色",
];
export function AvatarEditor({ open, onOpenChange, bot, api }) {
  const [avatar, setAvatar] = useState(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const file = useRef();
  useEffect(() => {
    if (open && bot) {
      setAvatar(bot.avatar || defaultAvatar(bot.id));
      setError("");
    }
  }, [open, bot?.id]);
  if (!bot) return null;
  async function save(value) {
    setBusy(true);
    setError("");
    try {
      await api.bot.update({ botId: bot.id, avatar: value });
      onOpenChange(false);
    } catch (e) {
      setError(
        e.reason === "invalidRequest"
          ? "该 server 暂不支持头像编辑，请更新 server。"
          : "头像未保存，请稍后重试。",
      );
    } finally {
      setBusy(false);
    }
  }
  async function upload(event) {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (!selected) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(selected.type) ||
      selected.size > 524288
    ) {
      setError("请选择 512 KB 以内的 PNG、JPEG 或 WebP 图片。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const data = await new Promise((done, reject) => {
        const reader = new FileReader();
        reader.onload = () => done(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(selected);
      });
      const { bot: updated } = await api.bot.avatarUpload({
        botId: bot.id,
        mime: selected.type,
        data,
      });
      setAvatar(updated.avatar);
    } catch (e) {
      setError(
        e.reason === "invalidRequest"
          ? "该 server 暂不支持图片头像，请更新 server。"
          : "图片未上传，请检查格式或稍后重试。",
      );
    } finally {
      setBusy(false);
    }
  }
  const pickShape = (shape) =>
    setAvatar((old) => ({
      shape: Number(shape),
      color: old?.color || defaultAvatar(bot.id).color,
    }));
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="avatar-editor" maxWidth="500px">
        <Flex align="center" justify="between">
          <div>
            <Dialog.Title>编辑头像</Dialog.Title>
            <Dialog.Description size="2">{bot.name} 的头像</Dialog.Description>
          </div>
          <Dialog.Close>
            <Button aria-label="关闭头像编辑" variant="ghost" color="gray">
              <X size={18} />
            </Button>
          </Dialog.Close>
        </Flex>
        <div className="avatar-editor-preview">
          <BotAvatar id={bot.id} name={bot.name} avatar={avatar} size={100} />
        </div>
        <Tabs.Root defaultValue="bot">
          <Tabs.List>
            <Tabs.Trigger value="bot">Bot</Tabs.Trigger>
            <Tabs.Trigger value="upload">上传</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="bot">
            <RadioGroup.Root
              className="avatar-shapes"
              value={String(avatar?.shape ?? 0)}
              onValueChange={pickShape}
              aria-label="头像形状"
            >
              {avatarShapes.map((_shape, i) => (
                <RadioGroup.Item
                  key={i}
                  value={String(i)}
                  aria-label={avatarShapeNames[i]}
                  disabled={busy}
                >
                  <BotAvatar
                    id="preview"
                    avatar={{
                      shape: i,
                      color: avatar?.color || avatarColors[6],
                    }}
                    size={54}
                  />
                </RadioGroup.Item>
              ))}
            </RadioGroup.Root>
            <RadioGroup.Root
              className="avatar-colors"
              value={avatar?.color}
              onValueChange={(color) =>
                setAvatar((old) => ({ ...old, color, picture: undefined }))
              }
              aria-label="头像颜色"
            >
              {avatarColors.map((color, i) => (
                <RadioGroup.Item
                  key={color}
                  value={color}
                  aria-label={colorNames[i]}
                  style={{ "--swatch": color }}
                  disabled={busy}
                />
              ))}
            </RadioGroup.Root>
            <Button
              variant="ghost"
              color="gray"
              size="2"
              disabled={busy}
              onClick={() =>
                setAvatar({
                  shape: Math.floor(Math.random() * 13),
                  color:
                    avatarColors[
                      Math.floor(Math.random() * avatarColors.length)
                    ],
                })
              }
            >
              <Shuffle size={15} />
              随机
            </Button>
          </Tabs.Content>
          <Tabs.Content value="upload">
            <div className="avatar-upload">
              <Upload size={25} />
              <Text size="2">PNG、JPEG 或 WebP，最大 512 KB</Text>
              <Text size="1" color="gray">
                图片保存在当前 runtime，不会同步到其他 server。
              </Text>
              <input
                type="file"
                ref={file}
                aria-label="上传头像图片"
                accept="image/png,image/jpeg,image/webp"
                onChange={upload}
                disabled={busy}
              />
            </div>
          </Tabs.Content>
        </Tabs.Root>
        {error && (
          <Callout.Root color="red" role="alert">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
        <Flex justify="between" align="center" mt="5">
          <Button
            variant="ghost"
            color="gray"
            disabled={busy}
            onClick={() => void save(null)}
          >
            <RotateCcw size={14} />
            重置
          </Button>
          <Button disabled={busy} onClick={() => void save(avatar)}>
            {busy ? "正在保存…" : "保存头像"}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
