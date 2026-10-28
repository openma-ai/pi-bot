import React, { useLayoutEffect, useRef } from "react";

/** Bottom anchored until the message content reaches it; never covers the feed. */
export function FeedStatus({ children }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const node = ref.current, feed = node.parentElement, content = node.previousElementSibling;
    let pushed = 0;
    const position = () => {
      const box = node.getBoundingClientRect(), viewport = feed.getBoundingClientRect();
      const inset = parseFloat(getComputedStyle(feed).scrollPaddingBottom) || 0;
      const restingTop = box.top - pushed;
      const collision = Math.max(0, content.getBoundingClientRect().bottom + 8 - restingTop);
      pushed = Math.min(box.height + inset + 24, collision);
      node.style.transform = `translateY(${pushed}px)`;
      const clipped = Math.max(0, restingTop + pushed + box.height - (viewport.bottom - inset));
      node.style.clipPath = `inset(0 0 ${Math.min(box.height, clipped)}px 0)`;
    };
    const observer = new ResizeObserver(position);
    observer.observe(feed); observer.observe(content); observer.observe(node);
    feed.addEventListener("scroll", position, { passive: true }); position();
    return () => { observer.disconnect(); feed.removeEventListener("scroll", position); };
  }, []);
  return <div ref={ref} className="conversation-status" onFocusCapture={() => {
    // Keyboard focus must reveal a request that was pushed out of view.
    ref.current?.scrollIntoView({ block: "end", behavior: "instant" });
  }}>{children}</div>;
}
