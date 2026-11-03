import Foundation
import CoreGraphics
import AppKit

/// Keeps one wide CGVirtualDisplay alive for pi-bot session tiles (Linux :99 analogue).
/// Stdout: JSON lines. Stdin commands: {"cmd":"status"} | {"cmd":"shutdown"}
/// SIGTERM/SIGINT tear the display down by releasing the strong reference and exiting.

func makeVirtualDisplay(name: String, width: Int, height: Int, product: UInt32, serial: UInt32) -> NSObject? {
    guard let DescriptorClass = NSClassFromString("CGVirtualDisplayDescriptor") as? NSObject.Type,
          let DisplayClass = NSClassFromString("CGVirtualDisplay") as? NSObject.Type,
          let ModeClass = NSClassFromString("CGVirtualDisplayMode") as? NSObject.Type,
          let SettingsClass = NSClassFromString("CGVirtualDisplaySettings") as? NSObject.Type else {
        return nil
    }
    let descriptor = DescriptorClass.init()
    descriptor.setValue(UInt32(0x5049424F), forKey: "vendorID") // PIBO
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

    guard let raw = (DisplayClass as NSObject.Type).perform(NSSelectorFromString("alloc"))?.takeUnretainedValue() as? NSObject,
          let virtualDisplay = raw.perform(NSSelectorFromString("initWithDescriptor:"), with: descriptor)?.takeUnretainedValue() as? NSObject else {
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

let args = CommandLine.arguments
func argValue(_ name: String, fallback: String) -> String {
    if let i = args.firstIndex(of: name), i + 1 < args.count { return args[i + 1] }
    return fallback
}
let width = Int(argValue("--width", fallback: "2560")) ?? 2560
let height = Int(argValue("--height", fallback: "800")) ?? 800
let name = argValue("--name", fallback: "PiBot-Companion")
let originX = Int32(argValue("--origin-x", fallback: String(-width))) ?? Int32(-width)
let originY = Int32(argValue("--origin-y", fallback: "0")) ?? 0
let product = UInt32(argValue("--product", fallback: "6001")) ?? 6001
let serial = UInt32(argValue("--serial", fallback: "930001")) ?? 930001

guard let companion = makeVirtualDisplay(name: name, width: width, height: height, product: product, serial: serial) else {
    emit(["ok": false, "error": "CGVirtualDisplay create failed"])
    exit(1)
}
var retained: NSObject? = companion
let displayID = (companion.value(forKey: "displayID") as? NSNumber)?.uint32Value ?? 0
if displayID == 0 {
    emit(["ok": false, "error": "displayID is 0"])
    exit(1)
}

var config: CGDisplayConfigRef?
if CGBeginDisplayConfiguration(&config) == .success, let config {
    _ = CGConfigureDisplayOrigin(config, CGDirectDisplayID(displayID), originX, originY)
    // .forSession: vanishes with this process / logout — avoids permanent orphans.
    let done = CGCompleteDisplayConfiguration(config, .forSession)
    if done != .success {
        emit(["ok": false, "error": "CGCompleteDisplayConfiguration failed", "code": done.rawValue])
        exit(1)
    }
}

Thread.sleep(forTimeInterval: 0.4)
emit([
    "ok": true,
    "event": "ready",
    "pid": ProcessInfo.processInfo.processIdentifier,
    "name": name,
    "display": displayInfo(companion, width: width, height: height),
])

func shutdown() {
    retained = nil
    emit(["ok": true, "event": "shutdown"])
    exit(0)
}

signal(SIGTERM) { _ in shutdown() }
signal(SIGINT) { _ in shutdown() }

FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty { return }
    guard let text = String(data: data, encoding: .utf8) else { return }
    for line in text.split(whereSeparator: \.isNewline) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { continue }
        guard let payload = try? JSONSerialization.jsonObject(with: Data(trimmed.utf8)) as? [String: Any],
              let cmd = payload["cmd"] as? String else {
            emit(["ok": false, "error": "invalid json"])
            continue
        }
        DispatchQueue.main.async {
            switch cmd {
            case "status":
                if let retained {
                    emit(["ok": true, "event": "status", "pid": ProcessInfo.processInfo.processIdentifier, "display": displayInfo(retained, width: width, height: height)])
                } else {
                    emit(["ok": false, "error": "display gone"])
                }
            case "shutdown":
                shutdown()
            default:
                emit(["ok": false, "error": "unknown cmd \(cmd)"])
            }
        }
    }
}

RunLoop.main.run()
