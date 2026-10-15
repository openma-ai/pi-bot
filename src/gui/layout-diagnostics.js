// Debug opt-in; numeric geometry only, never message text or credentials.
(() => {
  if (window.__pibotLayoutProbe) return;
  window.__pibotLayoutProbe = true;
  let timer, observedComposer;
  const resize = new ResizeObserver(() => update());
  const rect = element => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  };
  const sample = () => {
    const app = document.querySelector('.app'), input = document.querySelector('.message-input'), vv = window.visualViewport;
    const composer = document.querySelector(".composer");
    if (composer && composer !== observedComposer) { resize.disconnect(); resize.observe(composer); observedComposer = composer; }
    const bubbles = [...document.querySelectorAll('.bubble')].map(rect);
    const metrics = { at: Date.now(), innerWidth, innerHeight, clientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth, scrollX, scrollY,
      viewport: vv ? { width: vv.width, height: vv.height, offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop, scale: vv.scale } : null,
      pins: [...document.querySelectorAll(".pinned-conversation")].map(rect), pinHeading: rect(document.querySelector(".pinned-heading")), pinUserSelect: document.querySelector(".pinned-conversation") ? getComputedStyle(document.querySelector(".pinned-conversation")).webkitUserSelect : null, runningCount: document.querySelectorAll('.activity-line[data-activity="working"]').length, partialBubbleCount: document.querySelectorAll(".streaming-label").length,
      page: app?.dataset.phonePage, phone: app?.dataset.phone, focused: document.activeElement === input,
      inputFont: input ? getComputedStyle(input).fontSize : null, app: rect(app), main: rect(document.querySelector('.main')),
      header: rect(document.querySelector('.main .header')), composer: rect(document.querySelector('.composer')),
      send: rect(document.querySelector('.send-button')), input: rect(input),
      bubbleMinX: bubbles.length ? Math.min(...bubbles.map(r => r.x)) : null,
      bubbleMaxRight: bubbles.length ? Math.max(...bubbles.map(r => r.right)) : null };
    const history = window.__pibotLayoutHistory ||= [];
    history.push({ ...metrics });
    if (history.length > 20) history.shift();
    window.__TAURI_INTERNALS__?.invoke('layout_diagnostics', { metrics: { ...metrics, history } }).catch(() => {});
  };
  const update = () => { clearTimeout(timer); timer = setTimeout(sample, 100); };
  ['resize', 'focusin', 'focusout', 'hashchange'].forEach(event => window.addEventListener(event, update));
  window.visualViewport?.addEventListener('resize', update);
  window.visualViewport?.addEventListener('scroll', update);
  new MutationObserver(update).observe(document.body, { subtree: true, childList: true });
  update();
})();
