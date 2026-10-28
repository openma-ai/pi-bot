import React, { useLayoutEffect, useRef } from "react";
import "./floating-composer.css";

/** Reserve the capsule's measured height in the feed, including multiline input. */
export function FloatingComposer({ children, conversationRef, pinnedToEnd }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const node = ref.current, parent = node.parentElement;
    let height = -1;
    const measure = () => {
      const next = Math.ceil(node.getBoundingClientRect().height);
      if (next === height) return;
      height = next;
      parent.style.setProperty("--composer-inset", `${next + 12}px`);
      const feed = conversationRef.current;
      if (feed && pinnedToEnd.current) feed.scrollTop = feed.scrollHeight;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node); measure();
    return () => { observer.disconnect(); parent.style.removeProperty("--composer-inset"); };
  }, [conversationRef, pinnedToEnd]);
  return <div ref={ref} className="composer-area">{children}</div>;
}
