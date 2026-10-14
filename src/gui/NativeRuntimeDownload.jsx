import { useEffect, useState } from "react";
export function NativeRuntimeDownload() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    if (window.__PIBOT_NATIVE__) {
      void window.__PIBOT_NATIVE__.call("runtime_distribution_status").then(setStatus).catch(() => {});
    }
  }, []);
  if (!status?.supported) return null;
  return (
    <section className="native-runtime-download" aria-label="本地运行环境安装">
      <strong>本地运行环境</strong>
      <p>单独管理版本与安装。当前尚未发布可信安装包；可以连接已独立安装并启动的 runtime。</p>
      <p>支持平台：{status.platform} · 安装状态：未通过客户端安装 · 版本：无</p>
      <button type="button" disabled>下载本地运行环境（尚未发布）</button>
    </section>
  );
}
