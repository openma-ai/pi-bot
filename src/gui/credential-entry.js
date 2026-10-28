import { configureNativeViewport } from "./native-viewport.ts";
import { invoke } from "@tauri-apps/api/core";
import "./credential.css";
configureNativeViewport();
const form = document.querySelector("form"), input = document.querySelector("input"), button = document.querySelector("button"), status = document.querySelector("#status");
const heading = document.querySelector("h1"), label = document.querySelector("label"), detail = document.querySelector("#detail");
let checking = true, busy = false, locked = false, stopped = false, metadataAvailable = true, pollTimer;
const terminal = new Set(["complete", "cancelled", "failed", "expired"]);
function setDisabled() { input.disabled = button.disabled = checking || busy || locked; }
function schedule(delay = 1200) {
  clearTimeout(pollTimer);
  if (!stopped && metadataAvailable) pollTimer = setTimeout(refresh, delay);
}
async function refresh() {
  if (stopped) return;
  if (busy) { schedule(); return; }
  let delay = 1200;
  try {
    const metadata = await invoke("credential_form_metadata");
    if (stopped) return;
    checking = false;
    if (terminal.has(metadata.state)) {
      stopped = true; input.value = ""; form.hidden = true;
      status.textContent = metadata.state === "complete" ? "授权已完成。" : "这个授权步骤已结束。";
      // Native closes only this bound window; no generic close/cancel permission.
      clearTimeout(pollTimer); return;
    }
    locked = metadata.state === "locked";
    const labels = { manual_code: "授权回跳地址", api_key: "API key", authorization_code: "授权输入", credential: "安全输入" };
    label.textContent = labels[metadata.fieldType] || "安全输入";
    heading.textContent = metadata.fieldType === "api_key" ? "设置 API key" : label.textContent;
    detail.textContent = metadata.fieldType === "manual_code"
      ? "仅在浏览器未能自动返回时，粘贴授权完成后的回跳地址。"
      : "只提交给当前运行环境，不会进入聊天记录。";
    if (!locked) status.textContent = "";
  } catch (error) {
    checking = false;
    const message = typeof error === "string" ? error : String(error?.message || "");
    if (/command.*(?:not found|unknown|not allowed)|unknown.*command/i.test(message)) {
      // An older native binary has no metadata API. Keep its existing secure
      // submission route usable, without retrying auth or closing anything.
      metadataAvailable = false;
      status.textContent = "";
    } else {
      checking = true;
      status.textContent = "暂时无法确认授权状态，正在重新检查。";
      delay = 5000;
    }
  } finally { setDisabled(); schedule(delay); }
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (checking || busy || locked || stopped || !input.value.trim()) return;
  const secret = input.value;
  input.value = ""; busy = true; clearTimeout(pollTimer); setDisabled();
  try {
    await invoke("credential_submit", { secret });
    status.textContent = metadataAvailable ? "已提交，等待授权完成。" : "已提交，可以关闭此窗口。";
  } catch {
    status.textContent = "提交结果尚未确认，请在模型设置中检查；不会自动重试。";
  } finally {
    busy = false; locked = true; setDisabled();
    if (metadataAvailable) void refresh();
  }
});
window.addEventListener("beforeunload", () => { stopped = true; clearTimeout(pollTimer); input.value = ""; });
setDisabled();
void refresh();
