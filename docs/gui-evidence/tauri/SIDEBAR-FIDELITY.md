# Sidebar reference pass

User references were inspected directly: current `libfile_28b2b82f711481918c830d82a8f0d298`, desired `libfile_e557edf0af708191893388fadb60ac7c`.

The rigid appearance came from small repeated upright fallback shapes, a desktop timestamp column, smaller type, and a remembered narrow width. Existing default/expand sizing was already 25.5% of the current window, but the saved 281px width from an earlier smaller window remained 281px after maximizing. Saved user settings are intentionally not silently migrated or reset. For this explicitly requested wider comparison, the existing collapse/expand action selected 441px at a 1728px viewport, then persisted it normally; relaunch restored 441px. No new sidebar persistence mechanism was added.

Changes: five deterministic asymmetric fallback silhouettes and stable angles (-20, 12, -12, 20, -5 degrees), keeping existing color identity. Actual uploaded pictures and explicitly selected shapes/colors retain their rendering. Expanded bot avatar box 40→52 CSS px, pinned 48→88; phone regular 44 and pinned76; collapsed sizes/centered targets unchanged. Names 14→16px and previews12→14px. Desktop timestamps removed, phone timestamps retained. Selected rows stay broad/rounded; pinned group remains centered with spacing adjusted to the reference. Search/new visible circles24→40px on native desktop, glyph17→21px with1.7 stroke; collapsed and phone targets44px. No unrelated reference controls added.

## Matched comparison

Both local desktop captures are 3456×2006 raster pixels (1728×1003 CSS px at2×), same eight fixture bots, same one pinned Fixture Bot6, same selected Fixture Bot7. Connection phase differs because the disposable fixture was restarted for the after capture; the sidebar data/pin count are identical. Images are actual native captures, not reconstructed mockups.

- Sidebar281→441 CSS px,16.26%→25.52% of viewport. Reference inner panel is approximately513/2006=25.57% (exclude its outer21px frame).
- Native circles48→80 raster px (24→40 CSS), or28.44→47.41px at a normalized2048-wide capture. Reference circles approximately46px.
- Colored regular silhouette measured56→80 raster px, or33.19→47.41px at2048-wide normalization. Reference regular silhouettes approximately44px. Different silhouettes have different visible bounds.
- Pinned silhouette65→136 raster px, or38.52→80.59px normalized; reference approximately75px. Actual hit card stays centered: panel center441 raster px, asymmetric visible silhouette center443.5px (1.25 CSS px difference). Reference is also optically asymmetric.
- Collapsed hit-target column remains centered at38 CSS px in76px rail; glyph rotation does not rotate/offset hit targets, labels, or status badges.

## Actual validation

`npm run gui:check`, `npx tsc --noEmit`,9 GUI presentation tests, production GUI build and Tauri debug app build passed. Additional SSR assertions passed: identical ID gives identical markup;20 IDs produce all five fallback silhouettes; explicit shape/color and picture remain preserved.

Native UI: enlarged top search opens search; collapsed new opens bot/group menu; no titlebar interception; collapsed target alignment visually checked.360px phone list retains timestamps and enlarged44px actions; row context menu still opens. Escape dismisses menu. One pin and width441 restored after relaunch. Earlier zero/multiple-pin, keyboard menu, errors/reconnect coverage remains in UI-FEEDBACK-VERIFICATION.md. Real iOS touch, VoiceOver and device build remain unverified.

## Library screenshots (all version0)

- Before: `libfile_fc5e4e62a0648191bb57566909e4453e`
- After: `libfile_adeb15dda8c88191a4a25e6f012c147f`
- Collapsed: `libfile_c63726d78d68819195320a7ebf7aa732`
- Phone: `libfile_6e42ff1d06748191bc8ac5c720d55695`

All captures contain disposable fixture data only. No actual credentials, private runtime content, remote connections, push, publication, or installer replacement. Remaining visual gaps: glyph bounds are approximate (different text, silhouettes and source DPR); pinned image is about6 normalized pixels larger than reference. Chat bubble colors/layout were intentionally outside this sidebar-only pass.
