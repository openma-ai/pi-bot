import React, { useEffect, useState } from "react";
import { Button, Flex, Text, Code } from "@radix-ui/themes";
import QRCode from "qrcode";
import { browserCsrf } from "../sdk/browser-session.ts";

/** Remote access: pairing QR + short code, device list, revoke, connect-code rotation. */
export function RemoteAccessPanel({ baseUrl = "" }) {
  const [state, setState] = useState(null);
  const [pair, setPair] = useState(null);
  const [error, setError] = useState("");
  const call = async (path, body) => {
    const r = await fetch(baseUrl + path, {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin",
      headers: { "X-PiBot-CSRF": browserCsrf(baseUrl), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const v = await r.json();
    if (!r.ok) throw Error(v.error || "请求失败");
    return v;
  };
  const refresh = () => call("/remote/devices").then(setState, e => setError(e.message));
  useEffect(() => { refresh(); }, [baseUrl]);
  const start = async () => {
    setError("");
    try {
      const p = await call("/remote/admin", { action: "pair" }).catch(() => call("/remote/invite", {}));
      setPair({ ...p, qr: await QRCode.toDataURL(p.link, { errorCorrectionLevel: "L", margin: 1, width: 240 }) });
    } catch (e) { setError(e.message); }
  };
  return (
    <div className="settings-pane">
      <Flex direction="column" gap="3">
        <Text size="2" color="gray">中继：{state?.relay?.enabled ? state.relay.status : "未启用（仅本机配对）"}。所有请求都需要已配对设备的凭证；经中继的流量端到端加密。</Text>
        <Flex gap="2">
          <Button onClick={start}>生成配对码</Button>
          <Button variant="soft" color="red" onClick={async () => { if (confirm("轮换连接码会使所有旧二维码失效，所有远程设备需要重新配对。")) { await call("/remote/admin", { action: "rotate-code" }).catch(e => setError(e.message)); setPair(null); } }}>轮换连接码</Button>
        </Flex>
        {pair && (
          <Flex direction="column" gap="2" align="start">
            <img src={pair.qr} alt="配对二维码" width={240} height={240} />
            <Text>手动配对码：<Code>{pair.code}</Code>（一次性，10 分钟内有效）</Text>
          </Flex>
        )}
        {error && <Text color="red" size="2">{error}</Text>}
        <Text weight="bold">已配对设备</Text>
        {(state?.devices || []).map(d => (
          <Flex key={d.id} justify="between" align="center">
            <Text size="2">{d.name} · {d.via} · {d.lastSeenAt || d.createdAt}</Text>
            <Button size="1" variant="soft" color="red" onClick={async () => { await call("/remote/devices/revoke", { id: d.id }).catch(e => setError(e.message)); refresh(); }}>撤销</Button>
          </Flex>
        ))}
        {state && !state.devices.length && <Text size="2" color="gray">暂无设备</Text>}
      </Flex>
    </div>
  );
}
