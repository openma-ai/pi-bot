// The native shell owns connection authentication and SSH. Existing SDKs keep their HTTP/SSE shape.
if (window.__TAURI_INTERNALS__) {
  window.__PIBOT_NATIVE__ = { call: async (command, args) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke(command, args);
  } };
  const marker = document.createElement("meta");
  marker.name = "pibot-client";
  document.head.append(marker);
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (!/^\/(client\/rpc|runtime\/)/.test(url.pathname)) return originalFetch(input, options);
    const { invoke } = await import("@tauri-apps/api/core");
    if (url.pathname === "/client/rpc") {
      const frame = JSON.parse(options.body);
      try {
        const result = await invoke("runtime_control", { method: frame.method, params: frame.params });
        return Response.json({ jsonrpc: "2.0", id: frame.id, result });
      } catch (error) {
        return Response.json({ jsonrpc: "2.0", id: frame.id, error: { message: String(error) } });
      }
    }
    if (url.pathname.endsWith("/events")) {
      const { listen } = await import("@tauri-apps/api/event");
      const id = crypto.randomUUID();
      let unlisten;
      let finished = false;
      const body = new ReadableStream({
        async start(controller) {
          unlisten = await listen("native-stream", ({ payload }) => {
            if (payload.id !== id) return;
            if (payload.data) controller.enqueue(new Uint8Array(payload.data));
            if (payload.done) { finished = true; controller.close(); unlisten(); void invoke("stream_close", { id }); }
            if (payload.error) { finished = true; controller.error(Error(payload.error)); unlisten(); void invoke("stream_close", { id }); }
          });
          options.signal?.addEventListener("abort", () => {
            void invoke("stream_close", { id }); unlisten?.(); if (!finished) { finished = true; controller.close(); }
          }, { once: true });
          try {
            if (options.signal?.aborted) { finished = true; unlisten(); controller.close(); return; }
            await invoke("stream_open", { id, path: url.pathname + url.search, connection: new Headers(options.headers).get("X-PiBot-Connection") || "" });
            if (options.signal?.aborted) void invoke("stream_close", { id });
          } catch (error) { unlisten?.(); if (!finished) { finished = true; controller.error(Error(String(error))); } }
        },
        cancel() { unlisten?.(); void invoke("stream_close", { id }); },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    const response = await invoke("runtime_request", {
      path: url.pathname + url.search, method: options.method || "GET", body: options.body || "",
      connection: new Headers(options.headers).get("X-PiBot-Connection") || "",
    });
    return new Response(response.body || null, { status: response.status, headers: { "content-type": response.contentType } });
  };
}
