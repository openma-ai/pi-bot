# iOS page viewport fix — 2026-10-16

The native iOS webview inherited unrestricted browser page scaling. Some Radix portal fields also escaped the phone input font rule and could trigger iOS focus magnification. The native-only entry points now set a scale-1 viewport, preserving safe-area and keyboard options. All native iOS input, textarea and select elements have a minimum 16px font while preserving larger inherited text.

Desktop, Android and browser viewport policy remains unchanged. No touch events are cancelled, no native accessibility settings are overridden, and scrolling remains enabled. There is no dedicated image lightbox in the current app; custom content-viewer transforms are not intercepted, but image-viewer zoom and OS accessibility enlargement were not independently exercised.

## Verification

- `npm run gui:check`, `npm run check`, and `npm --prefix clients/tauri run build:gui`: passed.
- `node --import tsx --test test/native-viewport.test.ts test/gui-message-layout.test.ts test/gui-atomic-replies.test.ts test/gui-presentation.test.ts`: 26 passed.
- Xcode simulator debug build: passed, iPhone 17 / iOS 26.4 (installed runtime), ad-hoc local simulator signing only.
- XCTest coordinate gesture run: 1 passed, 0 failed. List/chat pinch, chat double-tap, composer focus, back navigation and chat scroll were exercised. The standalone UI runner exposed an empty app accessibility tree, so semantic element assertions were unavailable; screenshots plus debug numeric diagnostics independently establish the layout result.
- Every recorded visual viewport scale was 1. Full software keyboard focus reduced visual height from 874 to 471; composer bottom was 423, above the keyboard, with focused font 16px. Returning to the list dismissed focus and restored height 874. Separate hardware-keyboard run also passed. Simulator hardware keyboard setting was restored after testing.
- Isolated native dummy SSH probe passed Keychain lifecycle, host rejection, wrong-password rejection, streamed reply and forced reconnect. No production daemon or credentials used.

Evidence is local and ignored by git: `artifacts/ios-viewport/metrics.json`, `xctest.log`, and six named screenshots. Full test result: `/tmp/pibo-zoom-ui-keyboard.xcresult`; native build log: `/tmp/pibo-zoom-sim-final-build.log`. The temporary XCTest project is `/tmp/pibo-zoom-uitests/PiboZoomTests.xcodeproj` (scheme PiboZoomTests); simulator UUID `5CDB508A-95ED-4E48-B361-F49D8E3EB1E8`.

This source fix has not been uploaded to TestFlight or pushed remotely. Existing TestFlight 0.1.0(1) is unchanged and does not contain it. Physical-device confirmation requires a future separately authorized build distribution.
