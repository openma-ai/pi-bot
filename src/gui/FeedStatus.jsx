import React, { useLayoutEffect, useRef } from "react";

/** Bottom anchored until the message content reaches it; never covers the feed. */
export function FeedStatus({ children, pinnedToEnd }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const node = ref.current, feed = node.parentElement, content = node.previousElementSibling;
    let pushed = 0, frame = 0, height = -1;
    const position = () => {
      const nextHeight = node.getBoundingClientRect().height;
      if (height !== nextHeight) {
        height = nextHeight;
        // A newly visible Running/request row adds scroll height. Keep the
        // latest view pinned before computing collision and clipping; readers
        // looking through history keep their existing scroll position.
        if (pinnedToEnd?.current) feed.scrollTop = feed.scrollHeight;
      }
      const box = node.getBoundingClientRect(), viewport = feed.getBoundingClientRect();
      const inset = parseFloat(getComputedStyle(feed).scrollPaddingBottom) || 0;
      const restingTop = box.top - pushed;
      const collision = Math.max(0, content.getBoundingClientRect().bottom + 8 - restingTop);
      pushed = Math.min(box.height + inset + 24, collision);
      node.style.transform = `translateY(${pushed}px)`;
      const clipped = Math.max(0, restingTop + pushed + box.height - (viewport.bottom - inset));
      node.style.clipPath = `inset(0 0 ${Math.min(box.height, clipped)}px 0)`;
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); };
    const observer = new ResizeObserver(schedule);
    observer.observe(feed); observer.observe(content); observer.observe(node);
    feed.addEventListener("scroll", schedule, { passive: true }); position();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); feed.removeEventListener("scroll", schedule); };
  }, [pinnedToEnd]);
  return <div ref={ref} className="conversation-status" onFocusCapture={() => {
    // Keyboard focus must reveal a request that was pushed out of view.
    ref.current?.scrollIntoView({ block: "end", behavior: "instant" });
  }}>{children}</div>;
}
