import { invoke } from "@tauri-apps/api/core";
import "./credential.css";
const form = document.querySelector("form"), input = document.querySelector("input"), button = document.querySelector("button"), status = document.querySelector("#status");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const secret = input.value;
  input.value = "";
  button.disabled = true;
  try { await invoke("credential_submit", { secret }); status.textContent = "已提交，可以关闭此窗口。"; }
  catch { status.textContent = "提交未确认，请检查请求状态；不会自动重试。"; button.disabled = false; }
});
