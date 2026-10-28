import React from "react";
import { Button, Heading, Text } from "@radix-ui/themes";
import { Laptop, ArrowUpRight } from "lucide-react";

/** First connection choices live inside the messenger; recovery stays in Settings. */
export function ConnectionLanding({ runtime, onSettings }) {
  const builtin = runtime.status.profiles?.find(p => p.mode === "builtin");
  const local = !runtime.status.remoteOnly && runtime.status.builtinHarness?.supported && builtin;
  return <section className="connection-start" aria-label="开始使用 Pibo">
    <Heading as="h2" size="4">{local ? "从这里开始" : "连接你的工作空间"}</Heading>
    <Text as="p" size="2" color="gray">{local ? "在这台电脑运行，或接着使用远端的会话。" : "在设置中连接运行 Pibo 的电脑。"}</Text>
    <div className="connection-start-actions">
      {local && <Button disabled={runtime.busy || !runtime.status.builtinHarness.available}
        onClick={() => void runtime.connect(builtin).catch(() => {})}><Laptop size={16}/>在本机开始</Button>}
      <Button variant={local ? "soft" : "solid"} disabled={runtime.busy} onClick={onSettings}>
        {local ? "连接远端" : "前往连接设置"}<ArrowUpRight size={15}/>
      </Button>
    </div>
    {local && !runtime.status.builtinHarness.available && <Text as="p" size="1" color="gray">{runtime.status.builtinHarness.error || "此开发包尚未包含本机运行组件。"}</Text>}
  </section>;
}
