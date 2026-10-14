# Minimal Apple clients (development preview)

One SwiftUI/WKWebView shell for macOS 14+ and iOS 17+, using installed Apple tools and no third-party native dependencies. It reuses the existing React messenger and its HTTP/SSE protocol rather than duplicating conversations, streaming, task state, or runtime management. This is a shell preview, not a completed remote iOS integration.

## Build and run

From this directory:

```sh
bash scripts/build.sh macos
open build/macos/PiBot.app
bash scripts/build.sh ios-simulator
# With a booted installed simulator:
xcrun simctl install booted build/ios-simulator/PiBot.app
xcrun simctl launch booted dev.pibot.client
bash scripts/build.sh ios-device
```

Device output is unsigned and cannot be installed as-is. Device installation requires an Xcode app target, provisioning/signing identity, and a trusted device. No Apple enrollment, signing account, TestFlight, or Store submission is included. These commands build an arm64 development application bundle without installing SDKs.

For desktop, start the existing GUI/client from a separate development checkout using `npm run gui`, then enter `http://127.0.0.1:4317`. The GUI's existing connection settings support local or SSH remote runtimes. The native shell does not spawn, stop, or reconfigure a daemon automatically. Do not restart any currently running original runtime as part of testing this client.

## Remote gap

Architecture remains provisional: the user's question about pure web SSH did not select a gateway or an embedded iOS SSH client. The existing desktop/browser path already uses the Node client host's system SSH tunnel with `BatchMode=yes`, `StrictHostKeyChecking=yes`, and `ForwardAgent=no`. No browser JavaScript SSH transport is implemented. A raw forwarded daemon port is not enough when local/remote port numbers differ: Host/Origin and bearer handling are provided by the existing client host. No actual remote host was contacted for this preview.

Both clients accept HTTPS server origins; iOS rejects loopback and all HTTP origins. The existing daemon and client host bind to loopback and enforce loopback Host/Origin, with browser session cookies/CSRF and host bearer tokens. There is currently **no verified authenticated HTTPS gateway** accessible to iOS. Entering an HTTPS origin only opens its page; “Page loaded” does not prove an authenticated bot connection. Do not publicly expose the existing HTTP listener or weaken its checks.

A future gateway needs explicitly authorized access provisioning, TLS, browser-session authentication, correct host/origin and CSRF handling, authenticated SSE, and a remote-only GUI mode that removes host runtime-management and computer-use controls. No such gateway is deployed here. Cross-origin navigation is blocked, so cross-origin SSO must be designed before use. TLS validation uses WebKit defaults, with no bypass. The native shell stores only the server origin; cookies are nonpersistent. Credential persistence would require a reviewed Keychain interface and auth protocol, not a bearer token in defaults or a URL.

No simulated bot replies are included. Offline mode is the connection screen. Once a compatible gateway exists, the real GUI supplies conversation/history, sending, streaming and task/error states. Native controls supply reconnect/disconnect and navigation failure feedback. iOS may suspend WebKit and SSE in the background; reconnect on return refreshes real server history. There is no background agent, push, voice, updater, or computer-use integration in this scope.

## Verification

```sh
mkdir -p build/module-cache
xcrun swiftc -module-cache-path "$PWD/build/module-cache" Sources/ConnectionPolicy.swift tests/main.swift -o build/policy-tests
build/policy-tests
```

Estimated work: 1–2 engineering days for shell/local desktop integration and device QA; a further 1–3 days for authenticated remote gateway integration and reconnect tests, depending on deployment/auth choice. Packaging/signing/distribution is separate.

Observed checkpoint: Xcode 26.6 with macOS/iOS/Simulator 26.5 SDKs; arm64 macOS, simulator and unsigned device compilation succeeded. Connection-policy tests passed 12 checks. Desktop connection UI was opened and screenshot-verified through native UI tooling. Simulator execution is unverified because sandbox access to CoreSimulatorService/device inventory failed. No live daemon, SSH configuration, credentials, or public listener was changed. The iOS shell is not yet a usable Pi Bot remote client without a selected and tested transport.
