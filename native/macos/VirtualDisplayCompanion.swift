import Foundation
import CoreGraphics
import AppKit

/// One long-lived companion holding ONE CGVirtualDisplay PER BOT (Linux Xvfb :N analogue).
/// Each display carries a stable, unique, non-zero vendor/product/serial derived by the daemon
/// from the bot/screen id, so WindowServer treats it as the same monitor across restarts and
/// does not prompt mirror/extend (PerpetualBeta/ActiveSpace b1ebdbf; Crisp VirtualDisplayService).
/// All CGVirtualDisplay work runs on the main thread (descriptor queue = main).
///
/// Stdin JSON lines:
///   {"cmd":"create","bot":"b","width":1280,"height":800,"vendor":N,"product":N,"serial":N,"name":"..","originX"?:N,"originY"?:N}
///   {"cmd":"destroy","bot":"b"}   -> releases that bot's object only
///   {"cmd":"list"} | {"cmd":"shutdown"}
/// Stdout JSON lines: {"event":"ready"} then one reply per command (echoing "bot").
/// stdin EOF / SIGTERM / SIGINT release every display and exit.

func makeVirtualDisplay(name: String, width: Int, height: Int, vendor: UInt32, product: UInt32, serial: UInt32) -> NSObject? {
    guard let DescriptorClass = NSClassFromString("CGVirtualDisplayDescriptor") as? NSObject.Type,
          let DisplayClass = NSClassFromString("CGVirtualDisplay") as? NSObject.Type,
          let ModeClass = NSClassFromString("CGVirtualDisplayMode") as? NSObject.Type,
          let SettingsClass = NSClassFromString("CGVirtualDisplaySettings") as? NSObject.Type else {
        return nil
    }
    let descriptor = DescriptorClass.init()
    descriptor.setValue(vendor, forKey: "vendorID")
    descriptor.setValue(product, forKey: "productID")
    descriptor.setValue(serial, forKey: "serialNum")
    descriptor.setValue(name, forKey: "name")
    descriptor.setValue(UInt32(width), forKey: "maxPixelsWide")
    descriptor.setValue(UInt32(height), forKey: "maxPixelsHigh")
    let ppi = 110.0
    descriptor.setValue(NSValue(size: CGSize(width: 25.4 * Double(width) / ppi, height: 25.4 * Double(height) / ppi)), forKey: "sizeInMillimeters")
    descriptor.setValue(NSValue(point: NSPoint(x: 0.6797, y: 0.3203)), forKey: "redPrimary")
    descriptor.setValue(NSValue(point: NSPoint(x: 0.2559, y: 0.6983)), forKey: "greenPrimary")
    descriptor.setValue(NSValue(point: NSPoint(x: 0.1494, y: 0.0557)), forKey: "bluePrimary")
    descriptor.setValue(NSValue(point: NSPoint(x: 0.3125, y: 0.3291)), forKey: "whitePoint")
    descriptor.setValue(DispatchQueue.main, forKey: "queue")

    // alloc returns +1 which initWithDescriptor: consumes; init returns +1 that we own.
    // takeRetainedValue() balances it so `retained = nil` really deallocates the display
    // (an extra unbalanced retain kept the display alive after shutdown in round 1).
    guard let raw = (DisplayClass as NSObject.Type).perform(NSSelectorFromString("alloc"))?.takeUnretainedValue() as? NSObject,
          let virtualDisplay = raw.perform(NSSelectorFromString("initWithDescriptor:"), with: descriptor)?.takeRetainedValue() as? NSObject else {
        return nil
    }
    let settings = SettingsClass.init()
    settings.setValue(false, forKey: "hiDPI")
    let modeSel = NSSelectorFromString("initWithWidth:height:refreshRate:")
    guard let modeAlloc = (ModeClass as NSObject.Type).perform(NSSelectorFromString("alloc"))?.takeUnretainedValue() as? NSObject else { return nil }
    typealias ModeInit = @convention(c) (AnyObject, Selector, Int, Int, Double) -> Unmanaged<AnyObject>?
    let modeImp = unsafeBitCast(modeAlloc.method(for: modeSel), to: ModeInit.self)
    guard let mode = modeImp(modeAlloc, modeSel, width, height, 60.0)?.takeUnretainedValue() as? NSObject else { return nil }
    settings.setValue([mode], forKey: "modes")
    typealias ApplyFn = @convention(c) (AnyObject, Selector, AnyObject) -> Bool
    let applySel = NSSelectorFromString("applySettings:")
    let apply = unsafeBitCast(virtualDisplay.method(for: applySel), to: ApplyFn.self)
    guard apply(virtualDisplay, applySel, settings) else { return nil }
    return virtualDisplay
}

func emit(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict),
          let line = String(data: data, encoding: .utf8) else { return }
    fputs(line + "\n", stdout)
    fflush(stdout)
}

func displayInfo(_ display: NSObject, width: Int, height: Int) -> [String: Any] {
    let displayID = (display.value(forKey: "displayID") as? NSNumber)?.uint32Value ?? 0
    let bounds = CGDisplayBounds(CGDirectDisplayID(displayID))
    return [
        "displayID": displayID,
        "width": width,
        "height": height,
        "bounds": [
            "x": bounds.origin.x,
            "y": bounds.origin.y,
            "w": bounds.size.width,
            "h": bounds.size.height,
        ],
        "online": CGDisplayIsOnline(CGDirectDisplayID(displayID)) != 0,
        "active": CGDisplayIsActive(CGDirectDisplayID(displayID)) != 0,
        "main": CGDisplayIsMain(CGDirectDisplayID(displayID)) != 0,
    ]
}


final class Slot {
    var display: NSObject?
    let displayID: UInt32
    let width: Int, height: Int
    let vendor: UInt32, product: UInt32, serial: UInt32
    init(display: NSObject, displayID: UInt32, width: Int, height: Int, vendor: UInt32, product: UInt32, serial: UInt32) {
        self.display = display; self.displayID = displayID; self.width = width; self.height = height
        self.vendor = vendor; self.product = product; self.serial = serial
    }
    func describe(_ bot: String) -> [String: Any] {
        var d = displayInfo(display ?? NSObject(), width: width, height: height)
        d["displayID"] = displayID
        d["bot"] = bot; d["vendor"] = vendor; d["product"] = product; d["serial"] = serial
        return d
    }
}

var slots: [String: Slot] = [:]

func onlineIDs() -> [CGDirectDisplayID] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 64)
    var n: UInt32 = 0
    CGGetOnlineDisplayList(64, &ids, &n)
    return Array(ids.prefix(Int(n)))
}

func u32(_ v: Any?) -> UInt32? { (v as? NSNumber)?.uint32Value }

func create(_ p: [String: Any]) {
    guard let bot = p["bot"] as? String, !bot.isEmpty else { emit(["ok": false, "error": "bot required"]); return }
    if let existing = slots[bot] {
        emit(["ok": true, "event": "created", "bot": bot, "existing": true, "display": existing.describe(bot)]); return
    }
    guard let width = (p["width"] as? NSNumber)?.intValue, let height = (p["height"] as? NSNumber)?.intValue,
          width >= 320, height >= 240, width <= 3840, height <= 2160 else {
        emit(["ok": false, "bot": bot, "error": "width/height out of range"]); return
    }
    guard let vendor = u32(p["vendor"]), let product = u32(p["product"]), let serial = u32(p["serial"]),
          vendor != 0, product != 0, serial != 0 else {
        emit(["ok": false, "bot": bot, "error": "vendor/product/serial must be non-zero"]); return
    }
    if let clash = slots.first(where: { $0.value.serial == serial && $0.value.product == product }) {
        emit(["ok": false, "bot": bot, "error": "serial already used by \(clash.key)"]); return
    }
    let name = (p["name"] as? String) ?? "PiBot \(bot)"
    var made: NSObject? = autoreleasepool {
        makeVirtualDisplay(name: name, width: width, height: height, vendor: vendor, product: product, serial: serial)
    }
    guard made != nil else { emit(["ok": false, "bot": bot, "error": "CGVirtualDisplay create failed"]); return }
    let displayID: UInt32 = autoreleasepool { (made?.value(forKey: "displayID") as? NSNumber)?.uint32Value ?? 0 }
    if displayID == 0 { made = nil; emit(["ok": false, "bot": bot, "error": "displayID is 0"]); return }
    let slot = Slot(display: made!, displayID: displayID, width: width, height: height, vendor: vendor, product: product, serial: serial)
    made = nil // only the slot holds the display, so destroy deallocates it
    slots[bot] = slot
    if let ox = (p["originX"] as? NSNumber)?.int32Value, let oy = (p["originY"] as? NSNumber)?.int32Value {
        var config: CGDisplayConfigRef?
        if CGBeginDisplayConfiguration(&config) == .success, let config {
            _ = CGConfigureDisplayOrigin(config, CGDirectDisplayID(displayID), ox, oy)
            let done = CGCompleteDisplayConfiguration(config, .forSession)
            if done != .success {
                // Keep the display; report the placement failure (macOS 27.2 returned 1014 for wide modes).
                emit(["ok": true, "event": "warning", "bot": bot, "warning": "origin config failed", "code": done.rawValue])
            }
        }
    }
    // Wait (on the main run loop) until WindowServer lists it online.
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline && !onlineIDs().contains(CGDirectDisplayID(displayID)) {
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }
    emit(["ok": true, "event": "created", "bot": bot, "display": autoreleasepool { slot.describe(bot) }])
}

func destroy(_ bot: String, reply: Bool = true) -> [String: Any] {
    guard let slot = slots.removeValue(forKey: bot) else {
        let r: [String: Any] = ["ok": false, "event": "destroyed", "bot": bot, "error": "no display for bot"]
        if reply { emit(r) }
        return r
    }
    weak var probe = slot.display
    slot.display = nil
    let released = probe == nil
    let id = CGDirectDisplayID(slot.displayID)
    let deadline = Date().addingTimeInterval(2)
    var gone = false
    while Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        if !onlineIDs().contains(id) { gone = true; break }
    }
    // macOS 27.2 may keep a released display listed until the next create (measured); report it.
    let r: [String: Any] = ["ok": true, "event": "destroyed", "bot": bot, "displayID": slot.displayID, "released": released, "gone": gone]
    if reply { emit(r) }
    return r
}

var shuttingDown = false
func shutdown() {
    if shuttingDown { return }
    shuttingDown = true
    let results = slots.keys.sorted().map { destroy($0, reply: false) }
    emit(["ok": true, "event": "shutdown", "destroyed": results])
    exit(0)
}

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler { shutdown() }
termSource.resume()
let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
intSource.setEventHandler { shutdown() }
intSource.resume()

Thread.detachNewThread {
    while let line = readLine() {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { continue }
        guard let payload = try? JSONSerialization.jsonObject(with: Data(trimmed.utf8)) as? [String: Any],
              let cmd = payload["cmd"] as? String else {
            emit(["ok": false, "error": "invalid json"])
            continue
        }
        DispatchQueue.main.async {
            switch cmd {
            case "create": create(payload)
            case "destroy": _ = destroy((payload["bot"] as? String) ?? "")
            case "list":
                emit(["ok": true, "event": "list", "displays": slots.keys.sorted().map { slots[$0]!.describe($0) }])
            case "shutdown": shutdown()
            default: emit(["ok": false, "error": "unknown cmd \(cmd)"])
            }
        }
    }
    DispatchQueue.main.async { shutdown() }
}

emit(["ok": true, "event": "ready", "pid": ProcessInfo.processInfo.processIdentifier])
RunLoop.main.run()
