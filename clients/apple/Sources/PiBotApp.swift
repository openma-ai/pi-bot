import SwiftUI
import WebKit

@main
struct PiBotApp: App {
    var body: some Scene {
        WindowGroup { ClientView() }
    }
}

struct ClientView: View {
    @AppStorage("serverOrigin") private var origin = ""
    @State private var endpoint: URL?
    @State private var error = ""
    @State private var status = "Disconnected"
    @State private var revision = UUID()
    private var allowLocal: Bool {
        #if os(macOS)
        true
        #else
        false
        #endif
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "bubble.left.and.bubble.right")
                Text("Pi Bot").font(.headline)
                Spacer()
                Text(status).font(.caption).foregroundStyle(.secondary)
                if endpoint != nil {
                    Button("Reconnect") { revision = UUID(); status = "Connecting…" }
                    Button("Disconnect") { endpoint = nil; status = "Disconnected" }
                }
            }.padding()
            Divider()
            if let endpoint {
                BrowserView(url: endpoint, status: $status, error: $error).id(revision)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("Connect to your bots").font(.title2.bold())
                        Text(allowLocal ? "Reuse your existing Pi Bot messenger. Its connection settings support local and SSH remote runtimes." : "Connect to an authenticated remote Pi Bot web gateway. No bot or agent runs on this device.")
                            .foregroundStyle(.secondary)
                        TextField(allowLocal ? "http://127.0.0.1:4317" : "https://your-server.example", text: $origin)
                            .textFieldStyle(.roundedBorder)
                            #if os(iOS)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                            #endif
                        Button("Connect") {
                            do { endpoint = try ConnectionPolicy.endpoint(origin, allowLocal: allowLocal); error = ""; status = "Connecting…" }
                            catch { self.error = error.localizedDescription }
                        }.buttonStyle(.borderedProminent)
                        if allowLocal {
                            Button("Use local messenger") { origin = "http://127.0.0.1:4317" }
                        }
                        Text(allowLocal ? "For remote bots, use the existing messenger's SSH profile. Direct HTTPS requires a separately configured authenticated gateway." : "Remote prerequisite: an existing authenticated HTTPS gateway. The current daemon is loopback-only; this app does not provision or expose it.")
                            .font(.caption).foregroundStyle(.secondary)
                        #if os(iOS)
                        Text("Streaming pauses when iOS suspends the app. Reconnect after returning to refresh history.").font(.caption).foregroundStyle(.secondary)
                        #endif
                    }.padding(24).frame(maxWidth: 540)
                }
            }
            if !error.isEmpty {
                Text(error).foregroundStyle(.red).font(.callout).padding().textSelection(.enabled)
            }
        }
        #if os(macOS)
        .frame(minWidth: 640, minHeight: 480)
        #endif
    }
}

final class BrowserCoordinator: NSObject, WKNavigationDelegate {
    var status: Binding<String>
    var error: Binding<String>
    let origin: URL
    init(_ view: BrowserView) { status = view.$status; error = view.$error; origin = view.url }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { status.wrappedValue = "Page loaded"; error.wrappedValue = "" }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError problem: Error) { fail(problem) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError problem: Error) { fail(problem) }
    private func fail(_ problem: Error) { status.wrappedValue = "Connection failed"; error.wrappedValue = problem.localizedDescription }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let target = action.request.url,
              target.scheme == origin.scheme, target.host == origin.host, target.port == origin.port,
              target.user == nil, target.password == nil else {
            error.wrappedValue = "Navigation outside this server was blocked."
            decisionHandler(.cancel); return
        }
        decisionHandler(action.targetFrame == nil ? .cancel : .allow)
    }
}

#if os(macOS)
struct BrowserView: NSViewRepresentable {
    let url: URL
    @Binding var status: String
    @Binding var error: String
    func makeCoordinator() -> BrowserCoordinator { BrowserCoordinator(self) }
    func makeNSView(context: Context) -> WKWebView { makeBrowser(url, context.coordinator) }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
#else
struct BrowserView: UIViewRepresentable {
    let url: URL
    @Binding var status: String
    @Binding var error: String
    func makeCoordinator() -> BrowserCoordinator { BrowserCoordinator(self) }
    func makeUIView(context: Context) -> WKWebView { makeBrowser(url, context.coordinator) }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
#endif

private func makeBrowser(_ url: URL, _ coordinator: BrowserCoordinator) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    // Auth cookies remain in memory and disappear on disconnect. No bearer token in defaults or URLs.
    configuration.websiteDataStore = .nonPersistent()
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = coordinator
    view.load(URLRequest(url: url))
    return view
}
