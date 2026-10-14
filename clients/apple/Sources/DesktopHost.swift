#if os(macOS)
import Foundation
import Combine

@MainActor
final class DesktopHost: ObservableObject {
    @Published var endpoint: URL?
    @Published var error = ""
    @Published var starting = false
    private var process: Process?
    private var timer: Timer?
    func start() {
        guard process == nil else {
            if let endpoint { self.endpoint = endpoint }
            return
        }
        guard let project = Bundle.main.object(forInfoDictionaryKey: "PiBotProject") as? String,
              let node = Bundle.main.object(forInfoDictionaryKey: "PiBotNode") as? String else {
            error = "Rebuild the development app to configure its Node host."; return
        }
        let root = URL(fileURLWithPath: project).appendingPathComponent("work/desktop")
        let child = Process()
        let ready = root.appendingPathComponent("host-ready.txt")
        let log = root.appendingPathComponent("host-startup.log")
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try Data().write(to: ready)
            try Data().write(to: log)
            child.standardOutput = try FileHandle(forWritingTo: ready)
            child.standardError = try FileHandle(forWritingTo: log)
        } catch { self.error = "Cannot create desktop development state: \(error.localizedDescription)"; return }
        child.executableURL = URL(fileURLWithPath: node)
        child.currentDirectoryURL = URL(fileURLWithPath: project)
        child.arguments = ["--import", "tsx", "clients/apple/desktop-host.ts", root.path]
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = URL(fileURLWithPath: node).deletingLastPathComponent().path + ":/usr/bin:/bin:/usr/sbin:/sbin"
        child.environment = environment
        child.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { [weak self] in
                self?.timer?.invalidate()
                self?.process = nil; self?.endpoint = nil; self?.starting = false
                self?.error = "Desktop host stopped. Check the development checkout and dependencies, then retry."
            }
        }
        do {
            starting = true; error = ""; try child.run(); process = child
            let deadline = Date().addingTimeInterval(15)
            timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    let text = (try? String(contentsOf: ready, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    if let url = try? ConnectionPolicy.endpoint(text, allowLocal: true) {
                        self.endpoint = url; self.starting = false; self.timer?.invalidate()
                    } else if Date() > deadline {
                        self.timer?.invalidate(); self.stop(); self.starting = false
                        self.error = "Desktop startup timed out. Check Node and dependencies, then retry."
                    }
                }
            }
        }
        catch { starting = false; self.error = "Could not start the desktop host: \(error.localizedDescription)" }
    }
    func stop() { process?.terminate() }
}
#endif
