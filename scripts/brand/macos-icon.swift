// Deterministic platform packaging of the approved raster: no mark redraw.
import AppKit
let input = CommandLine.arguments[1], output = CommandLine.arguments[2]
guard let source = NSImage(contentsOfFile: input),
      let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
      let context = NSGraphicsContext(bitmapImageRep: bitmap) else { fatalError("Cannot load approved source") }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.imageInterpolation = .high
NSColor.clear.setFill()
NSRect(x: 0, y: 0, width: 1024, height: 1024).fill(using: .copy)
let rect = NSRect(x: 100, y: 100, width: 824, height: 824)
let shape = NSBezierPath(roundedRect: rect, xRadius: 184, yRadius: 184)
NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow(); shadow.shadowColor = NSColor.black.withAlphaComponent(0.13); shadow.shadowBlurRadius = 14; shadow.shadowOffset = NSSize(width: 0, height: -7); shadow.set()
NSColor(calibratedRed: 1, green: 0.99, blue: 0.97, alpha: 1).setFill(); shape.fill()
NSGraphicsContext.restoreGraphicsState()
shape.addClip()
source.draw(in: rect, from: .zero, operation: .copy, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("Cannot encode icon") }
try png.write(to: URL(fileURLWithPath: output))
