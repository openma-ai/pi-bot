import React, { useLayoutEffect, useRef } from "react";
import "./floating-composer.css";

/** Reserve the capsule's measured height in the feed, including multiline input. */
export function FloatingComposer({ children, conversationRef, pinnedToEnd }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const node = ref.current, parent = node.parentElement;
    let height = -1, frame = 0;
    const measure = () => {
      const next = Math.ceil(node.getBoundingClientRect().height);
      if (next === height) return;
      height = next;
      parent.style.setProperty("--composer-inset", `${next + 12}px`);
      const feed = conversationRef.current;
      if (feed && pinnedToEnd.current) feed.scrollTop = feed.scrollHeight;
    };
    // Reserve space outside the observer delivery cycle to avoid resize loops.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame); frame = requestAnimationFrame(measure);
    });
    observer.observe(node); measure();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); parent.style.removeProperty("--composer-inset"); };
  }, [conversationRef, pinnedToEnd]);
  return <div ref={ref} className="composer-area">{children}</div>;
}
