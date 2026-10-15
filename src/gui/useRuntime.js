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
          setError("");
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
  const connect = async (profile) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      ++epoch.current;
      await Promise.all(
        [...beforeSwitch.current].map((fn) =>
          Promise.race([
            Promise.resolve().then(fn),
            new Promise((r) => setTimeout(r, 2000)),
          ]).catch(() => {}),
        ),
      );
      const next = await control.runtime.connect({ profile });
      setStatus(next);
      return next;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const configure = async (profile) => {
    ++epoch.current;
    const next = await control.runtime.configure({ profile });
    setStatus(next);
    return next;
  };
  const disconnect = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      ++epoch.current;
      await Promise.all([...beforeSwitch.current].map(fn => Promise.resolve().then(fn).catch(() => {})));
      const next = await control.runtime.disconnect({});
      setStatus(next);
    } catch (e) { setError(e.message); throw e; }
    finally { setBusy(false); }
  };
  const remove = async (id) => {
    ++epoch.current;
    const next = await control.runtime.remove({ id });
    setStatus(next);
  };
  const registerBeforeSwitch = useCallback((fn) => {
    beforeSwitch.current.add(fn);
    return () => beforeSwitch.current.delete(fn);
  }, []);
  return {
    registerBeforeSwitch,
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
