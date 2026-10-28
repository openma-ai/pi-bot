import React from "react";
import { BotAvatar, activityLabels } from "./BotAvatar.jsx";
import "./activity-status.css";

export function ActivityStatus({ id, name, activity }) {
  if (!["working", "queued", "interrupted"].includes(activity)) return null;
  const label = activityLabels[activity];
  return <div className="activity-line" role="status" aria-label={label} data-activity={activity}>
    <span className="activity-chip" aria-hidden="true">
      <BotAvatar id={id} name={name} activity={activity} size={20} animated />
      <span>{activity === "working" ? "Running" : activity === "queued" ? "Queued" : "Interrupted"}</span>
    </span>
    <span className="activity-chip activity-description" aria-hidden="true">{activity === "working" ? "正在处理" : label}</span>
  </div>;
}
