import React, { createContext, useContext, useState } from "react";
import { avatarVariant } from "./presentation.ts";

export const AvatarContext = createContext({ baseUrl: "", bots: [] });
export const avatarShapes = [
  "M12 22C13 11 23 8 34 10C46 6 54 16 53 29C58 43 47 55 33 53C17 57 7 44 12 22Z",
  "M13 16C22 7 43 8 51 19C59 30 51 48 39 53C25 59 10 49 9 35C7 27 8 21 13 16Z",
  "M19 10C31 5 47 9 51 23L55 38C54 51 39 57 24 52C10 49 6 35 12 22Z",
  "M32 8a24 24 0 1 0 0 48a24 24 0 1 0 0-48Z",
  "M20 9h24q11 0 11 11v24q0 11-11 11H20Q9 55 9 44V20Q9 9 20 9Z",
  "M32 6Q36 6 40 21L55 25Q60 28 48 37L48 52Q47 57 33 47L17 54Q11 55 17 38L6 28Q5 23 23 22Z",
  "M32 16C17-2 2 16 16 31C-2 47 16 65 32 49C48 66 66 48 49 32C65 15 47-1 32 16Z",
  "M32 18C18-1 0 14 10 31Q17 47 32 55Q48 46 55 31C65 14 47-1 32 18Z",
  "M32 5C25 15 10 32 10 41C10 61 55 62 55 39C55 25 45 12 32 5Z",
  "M20 13H44a19 19 0 0 1 0 38H20a19 19 0 0 1 0-38Z",
  "M24 9Q30 3 36 9L56 43Q60 54 46 54H14Q3 54 8 43Z",
  "M19 9H44L58 32L44 55H19L6 32Z",
  "M32 17C44-5 60 9 49 26C69 29 63 53 45 46C42 67 20 62 21 47C0 50-4 29 17 25C5 6 25-4 32 17Z",
];
export const avatarShapeNames = [
  "云朵",
  "软圆",
  "斜方",
  "圆形",
  "方形",
  "星形",
  "四叶",
  "爱心",
  "水滴",
  "胶囊",
  "三角",
  "六边",
  "花朵",
];
export const avatarColors = [
  "#f5f5f4",
  "#a66f39",
  "#ff334b",
  "#ff7413",
  "#f5a009",
  "#18c77a",
  "#13b8a6",
  "#2086f8",
  "#9360ff",
  "#f3319a",
  "#858585",
];
const defaultColors = [
  "#eb9b36",
  "#48b39f",
  "#9a7ce0",
  "#5a9cd7",
  "#d26e9c",
  "#c6c0b6",
];
export const defaultAvatar = (id) => {
  const variant = avatarVariant(id);
  return { shape: variant % 3, color: defaultColors[variant] };
};
export const activityLabels = {
  idle: "就绪",
  working: "正在处理",
  queued: "等待处理",
  attention: "有请求需要你处理",
  interrupted: "执行中断",
};
export function BotAvatar({
  id = "",
  name = "",
  activity = "idle",
  size = 40,
  animated = false,
  avatar,
}) {
  const variant = avatarVariant(id);
  const runtime = useContext(AvatarContext);
  const style =
    avatar === undefined
      ? runtime.bots.find((b) => b.id === id)?.avatar
      : avatar;
  const [failedPicture, setFailedPicture] = useState("");
  const picture =
    style?.picture && style.picture !== failedPicture
      ? `${runtime.baseUrl}/api/bot/${id}/avatar/${style.picture}`
      : "";
  return (
    <span
      className={`bot-avatar avatar-${variant} ${animated ? "avatar-live" : ""}`}
      data-activity={activity}
      style={{
        "--avatar-size": `${size}px`,
        ...(style?.color ? { color: style.color } : {}),
      }}
      role="img"
      aria-label={`${name} · ${activityLabels[activity]}`}
    >
      {picture ? (
        <img
          className="avatar-picture"
          src={picture}
          alt=""
          onError={() => setFailedPicture(style.picture)}
        />
      ) : (
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <g className="avatar-body">
            <path
              d={avatarShapes[style?.shape ?? variant % 3]}
              fill="currentColor"
            />
            <g className="avatar-eyes">
              <rect x="24" y="25" width="6" height="12" rx="3" />
              <rect x="37" y="25" width="6" height="12" rx="3" />
            </g>
          </g>
        </svg>
      )}
      {activity !== "idle" && <i className="avatar-status" />}
    </span>
  );
}
export function GroupAvatar({ members = [], size = 40 }) {
  return (
    <span
      className="group-avatar"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${members.length} 位成员`}
    >
      {members.slice(0, 3).map((b, i) => (
        <span
          key={b.id}
          style={{ left: i * size * 0.22, top: i === 1 ? 0 : size * 0.3 }}
        >
          <BotAvatar id={b.id} name={b.name} size={size * 0.7} />
        </span>
      ))}
    </span>
  );
}
