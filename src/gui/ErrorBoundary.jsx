import React from "react";
export class ErrorBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="interface-failure" role="alert">
        <h1>界面暂时无法显示</h1>
        <p>服务端的消息记录仍然保留。请重新载入界面。</p>
        <button onClick={() => window.location.reload()}>重新载入</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
