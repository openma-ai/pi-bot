import React, { useEffect, useRef, useState } from "react";
import { Button, Dialog, Flex, Text, Tabs } from "@radix-ui/themes";
import RFB from "@novnc/novnc";
export function DesktopPanel({
  botId,
  name,
  enabled,
  capabilities,
  api,
  baseUrl = "",
  registerBeforeSwitch,
}) {
  const [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [stamp, setStamp] = useState(Date.now()),
    [open, setOpen] = useState(false),
    [control, setControl] = useState(false),
    [controlling, setControlling] = useState(false);
  const [screen,setScreen]=useState(''),[viewerEpoch,setViewerEpoch]=useState(0);
  const [capability, setCapability] = useState(capabilities), [opening, setOpening] = useState(false);
  const openingRef = useRef(false), generation = useRef(0);
  const retryAttempt=useRef(0);
  const canvas = useRef(null),
    rfb = useRef(null),
    apiRef = useRef(api);
  apiRef.current = api;
  useEffect(() => {
    const version = ++generation.current;
    setReady(false); setOpen(false); setScreen(""); setError("");
    setCapability(capabilities); openingRef.current = false; setOpening(false);
    if (enabled && botId) void apiRef.current("/api/desktop/capabilities", {botId}).then(next => {
      if (version === generation.current) setCapability(next);
    }).catch(e => { if(version === generation.current) setError(e.message || "无法读取电脑能力"); });
    return () => { generation.current++; };
  }, [botId, enabled]);
  useEffect(() => {
    if (!enabled || !botId) return;
    let stopped = false;
    void apiRef.current("/api/desktop/capabilities", {botId}).then(next => {
      if (!stopped) {
        setCapability(next);
        if (next.vnc?.state !== "ready") { setReady(false); setOpen(false); }
      }
    }).catch(() => {});
    return () => { stopped = true; };
  }, [capabilities, botId, enabled]);
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => setStamp(Date.now()), 3000);
    return () => clearInterval(timer);
  }, [ready]);
  async function openScreen() {
    if (openingRef.current || !enabled || !botId) return;
    openingRef.current = true; setOpening(true); setError("");
    const version = generation.current;
    try {
      // Opening a view is an explicit user action. Merely inspecting capability
      // state must never bind a bot or start a desktop/VNC service.
      if (capability?.vnc?.state !== "ready") await apiRef.current("/api/desktop/bind", {botId});
      const next = await apiRef.current("/api/desktop/capabilities", {botId, refresh:true});
      if (version !== generation.current) return;
      setCapability(next);
      if (next.vnc?.state !== "ready") throw Error(next.vnc?.reason || "屏幕尚未就绪");
      setReady(true); setOpen(true);
    } catch(e) { if(version === generation.current) setError(e.message || "屏幕暂不可用"); }
    finally { if(version === generation.current) { openingRef.current=false;setOpening(false); } }
  }
  useEffect(()=>{
    if(!ready || !enabled)return;
    const abort=new AbortController();let objectUrl;
    fetch(`${baseUrl}/api/desktop/${botId}/screen?t=${stamp}`,{signal:abort.signal}).then(async response=>{if(!response.ok)throw Error("屏幕暂不可用");const blob=await response.blob();if(abort.signal.aborted)return;objectUrl=URL.createObjectURL(blob);setScreen(objectUrl);}).catch(e=>{if(!abort.signal.aborted)setError(String(e.message||e));});
    return()=>{abort.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[ready,enabled,botId,baseUrl,stamp]);
  useEffect(() => {
    if (!open || !ready) return;
    let cancelled=false, nativeId,retryTimer;
    const retry=()=>{if(cancelled)return;setControl(false);setError("屏幕连接中断，正在重新连接…");clearTimeout(retryTimer);retryTimer=setTimeout(()=>setViewerEpoch(v=>v+1),[1000,2000,5000,10000,30000][Math.min(retryAttempt.current++,4)]);};
    const t = setTimeout(async () => {
      if (!canvas.current) return;
      let url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${baseUrl}/api/desktop/${botId}/ws`;
      if(window.__PIBOT_NATIVE__) {
        nativeId=crypto.randomUUID();
        try {url=await window.__PIBOT_NATIVE__.call("desktop_open",{id:nativeId,path:`${baseUrl}/api/desktop/${botId}/ws`});}
        catch(e){if(!cancelled){if(/401|403|过期|撤销|重新登录/.test(String(e)))setError("服务登录已失效，请重新登录");else retry();}return;}
        if(cancelled){void window.__PIBOT_NATIVE__.call("stream_close",{id:nativeId});return;}
      }
      const v = new RFB(canvas.current, url, { shared: true });
      v.scaleViewport = true;
      v.resizeSession = false;
      v.viewOnly = true;
      rfb.current = v;
      v.addEventListener("connect",()=>{if(!cancelled&&rfb.current===v){retryAttempt.current=0;setError("");}});
      v.addEventListener("disconnect", () => {
        if (!cancelled&&rfb.current === v){v.viewOnly=true;retry();}
      });
    }, 0);
    return () => {
      cancelled=true;clearTimeout(t);clearTimeout(retryTimer);
      if(nativeId)void window.__PIBOT_NATIVE__?.call("stream_close",{id:nativeId});
      const previous = rfb.current;
      rfb.current = null;
      previous?.disconnect();
      setControl(false);
      apiRef
        .current("/api/desktop/control", { botId, take: false })
        .catch(() => {});
    };
  }, [open, ready, botId, baseUrl,viewerEpoch]);
  useEffect(
    () =>
      registerBeforeSwitch?.(async () => {
        if (rfb.current) rfb.current.viewOnly = true;
        await apiRef
          .current("/api/desktop/control", { botId, take: false })
          .catch(() => {});
        setControl(false);
        setOpen(false);
      }),
    [registerBeforeSwitch, botId],
  );
  async function toggle() {
    if (controlling) return;
    setControlling(true);
    setError("");
    try {
      await apiRef.current("/api/desktop/control", { botId, take: !control });
      setControl((v) => !v);
      if (rfb.current) rfb.current.viewOnly = control;
    } catch {
      setError("控制切换未完成，请重试");
    } finally {
      setControlling(false);
    }
  }
  useEffect(() => {
    if (!control) return;
    const t = setInterval(() => {
      apiRef
        .current("/api/desktop/control", { botId, take: true })
        .catch(() => {
          setControl(false);
          if (rfb.current) rfb.current.viewOnly = true;
        });
    }, 20000);
    return () => clearInterval(t);
  }, [control, botId]);
  return (
    <>
      <div className="computer-preview">
        {!enabled ? <Text color="gray">连接工作空间后查看电脑能力</Text> : <>
          <div className="capability-list" aria-label="宿主电脑能力">
            {[["computerUse", "电脑操作"], ["browser", "浏览器操作"], ["vnc", "屏幕查看"]].map(([key,label]) => {
              const item=capability?.[key];
              const labels={unsupported:"不支持",unconfigured:"未配置", "permission-required":"需要权限",unreachable:"无法连接",ready:"可用",unknown:"待确认"};
              return <div key={key}><Text as="p" size="2" weight="medium">{label} · {labels[item?.state] || "检测中"}</Text><Text as="p" size="1" color="gray">{item?.reason || "正在读取宿主状态…"}</Text></div>;
            })}
          </div>
          {error && <Text as="p" size="2" color="gray" role="status">{error}</Text>}
          {ready && screen && <button className="screen-preview" onClick={() => void openScreen()} aria-label={`打开 ${name} 的屏幕`}><img src={screen} alt={`${name} 的屏幕预览`} onError={() => setError("屏幕暂不可用")}/></button>}
          <Button mt="3" disabled={opening || !(capability?.canOpenView || capability?.vnc?.state === "ready")} onClick={() => void openScreen()}>{opening ? "连接屏幕…" : "打开屏幕"}</Button>
        </>}
      </div>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Content className="computer-fullscreen" maxWidth="95vw">
          <Dialog.Title>{name} 的屏幕</Dialog.Title>
          <Dialog.Description size="1">
            {control ? "你正在控制，agent 的桌面操作已暂停" : "观看实时画面"}
          </Dialog.Description>
          {error && (
            <Text as="p" color="red" size="2">
              {error}
            </Text>
          )}
          <div className="vnc-stage" ref={canvas} />
          <Flex className="desktop-controls" align="center" justify="between" gap="3" mt="3" wrap="wrap">
            <Text className="desktop-status" size="2" role="status">{control ? "Controlling" : "Watching"}</Text>
            <Flex className="desktop-actions" align="center" gap="2">
              <Button size="2" variant="soft" disabled={controlling || (!control && capability?.computerUse?.state !== "ready")} onClick={toggle}>
                {control ? "Return control" : "Take over"}
              </Button>
              <Dialog.Close>
                <Button size="2" className="desktop-close" variant="ghost">关闭</Button>
              </Dialog.Close>
            </Flex>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
