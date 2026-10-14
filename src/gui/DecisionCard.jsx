import React, { useState } from "react";
import {errorText} from "./useDaemon.js";
import { X } from "lucide-react";
export function DecisionCard({ request, onAnswer }) {
  const [answer, setAnswer] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [dismissed, setDismissed] = useState(false);
  const respond = async (text) => {
    setBusy(true);
    setError("");
    try {
      await onAnswer(text);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (dismissed)
    return (
      <button className="decision-reopen" onClick={() => setDismissed(false)}>
        回答待处理问题
      </button>
    );
  return (
    <section className="decision-card" aria-label="需要你的决定">
      <div className="decision-heading">
        <strong>{request.params.text}</strong>
        <button aria-label="稍后回答" onClick={() => setDismissed(true)}>
          <X size={17} />
        </button>
      </div>
      {request.params.choices?.length > 0 && (
        <div className="decision-options">
          {request.params.choices.map((choice, i) => (
            <button
              key={choice}
              disabled={busy}
              onClick={() => respond(choice)}
            >
              <kbd>{String.fromCharCode(65 + i)}</kbd>
              <span>{choice}</span>
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (answer.trim()) void respond(answer.trim());
        }}
      >
        <input
          aria-label="回答问题"
          placeholder="输入你的回答…"
          value={answer}
          disabled={busy}
          onChange={(e) => setAnswer(e.target.value)}
        />
        <button disabled={busy || !answer.trim()} type="submit">
          发送
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
