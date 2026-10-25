import {createRuntimeRestoration} from './runtime-restoration.ts';
import { useEffect, useState, useCallback, useRef } from "react";
import { RuntimeClient } from "../sdk/runtime-client.ts";
const control = new RuntimeClient();
const managed = !!document.querySelector('meta[name="pibot-client"]');
const direct = {
  profiles: null,
  active: {
    id: "direct",
    scope: "direct",
    mode: "local",
    baseUrl: "",
    label: "Local",
  },
  connecting: false,
};
export function useRuntime() {
  const restoration=useRef(createRuntimeRestoration(globalThis.localStorage)),connectPending=useRef(false);
  const [restoring,setRestoring]=useState(false);
  const beforeSwitch = useRef(new Set()),
    epoch = useRef(0);
  const [status, setStatus] = useState(
    managed ? { profiles: null, active: null, connecting: false } : direct,
  );
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!managed) return;
    const next = await control.runtime.status({});
    setStatus(next);
    return next;
  }, []);
  useEffect(() => {
    if (!managed) return;
    let stopped = false,
      inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const version = epoch.current;
        const next = await control.runtime.status({});
        if (!stopped && version === epoch.current) {
          setStatus(next);
          if(next.active)setError("");
          const profile=restoration.current.candidate(next,{hidden:document.hidden,busy:connectPending.current});
          if(profile&&window.__PIBOT_NATIVE__)void lifecycle.current.connect(profile,{automatic:true}).catch(()=>{});
        }
      } catch (e) {
        if (!stopped) setError(e.message);
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  const connect = async (profile,{automatic=false}={}) => {
    if(connectPending.current)throw Error("已有连接操作正在进行，请稍候");
    connectPending.current=true;
    if(!automatic)restoration.current.manual();
    setRestoring(automatic);
    const version=++epoch.current;
    setBusy(true);
    setError("");
    try {
      await Promise.all(
        [...beforeSwitch.current].map((fn) =>
          Promise.race([
            Promise.resolve().then(fn),
            new Promise((r) => setTimeout(r, 2000)),
          ]).catch(() => {}),
        ),
      );
      const next = await control.runtime.connect({ profile });
      if(version!==epoch.current)return;
      if(!next.active||next.active.profileId!==profile.id)throw Error("连接尚未完成，请稍后重试");
      restoration.current.connected(profile);
      setStatus(next);
      return next;
    } catch (e) {
      if(version===epoch.current){if(automatic)restoration.current.failed(e);setError(e.message);}
      throw e;
    } finally {
      if(version===epoch.current){connectPending.current=false;setBusy(false);setRestoring(false);}
    }
  };
  const configure = async (profile) => {
    restoration.current.manual();connectPending.current=false;setBusy(false);setRestoring(false);
    ++epoch.current;
    const next = await control.runtime.configure({ profile });
    setStatus(next);
    return next;
  };
  const disconnect = async () => {
    if(connectPending.current)return cancelConnect();
    if (busy) return;
    restoration.current.disable();
    setBusy(true); setError("");
    try {
      ++epoch.current;
      await Promise.all([...beforeSwitch.current].map(fn => Promise.resolve().then(fn).catch(() => {})));
      const next = await control.runtime.disconnect({});
      setStatus(next);
    } catch (e) { setError(e.message); throw e; }
    finally { setBusy(false); }
  };
  const cancelConnect = async () => {
    restoration.current.disable();connectPending.current=false;setRestoring(false);
    ++epoch.current;
    const next=await control.runtime.disconnect({}); setStatus(next);setBusy(false);
  };
  const lifecycle=useRef({}); lifecycle.current={status,connect};
  useEffect(()=>{
    if(!managed||!window.__PIBOT_NATIVE__)return;
    const changed=()=>{
      const current=lifecycle.current;
      if(!current.status.remoteOnly)return;
      if(document.hidden){
        if(!current.status.active)return;
        ++epoch.current;connectPending.current=false;setBusy(false);setRestoring(false);
        void control.runtime.disconnect({}).then(next=>setStatus(next)).catch(()=>{});
      }else{restoration.current.foreground();void refresh().catch(()=>{});}
    };
    document.addEventListener('visibilitychange',changed);
    return()=>document.removeEventListener('visibilitychange',changed);
  },[refresh]);
  const remove = async (id) => {
    connectPending.current=false;setBusy(false);setRestoring(false);
    ++epoch.current;
    const next = await control.runtime.remove({ id });
    restoration.current.removed(id);
    setStatus(next);
  };
  const registerBeforeSwitch = useCallback((fn) => {
    beforeSwitch.current.add(fn);
    return () => beforeSwitch.current.delete(fn);
  }, []);
  return {
    restoring,
    displayRuntime:restoration.current.display(status.profiles),
    registerBeforeSwitch,
    cancelConnect,
    disconnect,
    remove,
    status,
    error,
    clearError: () => setError(""),
    busy: busy || status.connecting,
    connect,
    configure,
    refresh,
    managed,
  };
}
