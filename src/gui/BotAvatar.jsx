import React from "react";
import { avatarVariant } from "./presentation.ts";

const shapes = [
  "M12 22C13 11 23 8 34 10C46 6 54 16 53 29C58 43 47 55 33 53C17 57 7 44 12 22Z",
  "M13 16C22 7 43 8 51 19C59 30 51 48 39 53C25 59 10 49 9 35C7 27 8 21 13 16Z",
  "M19 10C31 5 47 9 51 23L55 38C54 51 39 57 24 52C10 49 6 35 12 22Z",
];
export const activityLabels = {
  idle: "就绪",
  working: "正在处理",
  queued: "等待处理",
  attention: "等待你的回答",
  interrupted: "执行中断",
};
export function BotAvatar({
  id = "",
  name = "",
  activity = "idle",
  size = 40,
  animated = false,
}) {
  const variant = avatarVariant(id);
  return (
    <span
      className={`bot-avatar avatar-${variant} ${animated ? "avatar-live" : ""}`}
      data-activity={activity}
      style={{ "--avatar-size": `${size}px` }}
      role="img"
      aria-label={`${name} · ${activityLabels[activity]}`}
    >
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <g className="avatar-body">
          <path d={shapes[variant % 3]} fill="currentColor" />
          <g className="avatar-eyes">
            <rect x="24" y="25" width="6" height="12" rx="3" />
            <rect x="37" y="25" width="6" height="12" rx="3" />
          </g>
        </g>
      </svg>
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
