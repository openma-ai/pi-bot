// The native iOS client has its own scrolling/keyboard layout. Keep the WKWebView
// at page scale 1; content viewers can still implement their own image transforms.
// Do not change the browser client, cancel touch events or disable OS accessibility.
type ViewportDocument = {
  querySelector(selector: string): { content: string } | null;
  documentElement: { dataset: Record<string, string | undefined> };
};
type Platform = Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints">;
export function configureNativeViewport(doc: ViewportDocument = document as unknown as ViewportDocument, nav: Platform = navigator) {
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent) ||
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  if (!ios) return;
  const viewport = doc.querySelector('meta[name="viewport"]');
  if (!viewport) return;
  const options = viewport.content.split(",").map(value => value.trim())
    .filter(value => !/^(minimum-scale|maximum-scale|user-scalable)\s*=/.test(value));
  viewport.content = [...options, "minimum-scale=1", "maximum-scale=1", "user-scalable=no"].join(",");
  doc.documentElement.dataset.nativeIos = "true";
}

// The messenger scrolls inside its own containers. WKWebView may scroll the
// outer document to the focused textarea before the visual viewport resizes.
// Cancel only that outer-page movement, leaving message/dialog scrolling alone.
export function restoreNativePageOrigin(
  doc: {documentElement: {dataset: Record<string, string | undefined>}},
  win: {scrollX: number; scrollY: number; visualViewport?: {scale: number} | null; scrollTo(x: number, y: number): void},
) {
  if (doc.documentElement.dataset.nativeIos !== 'true' ||
      Math.abs((win.visualViewport?.scale ?? 1) - 1) > 0.01 ||
      (!win.scrollX && !win.scrollY)) return;
  win.scrollTo(0, 0);
}
