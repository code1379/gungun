import AppKit

let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)
image.lockFocus()
NSGraphicsContext.current?.cgContext.clear(CGRect(x: 0, y: 0, width: 1024, height: 1024))
NSColor(calibratedRed: 0.20, green: 0.26, blue: 0.35, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 45, y: 45, width: 934, height: 934), xRadius: 218, yRadius: 218).fill()
let mark = NSAttributedString(string: "g", attributes: [
    .font: NSFont.systemFont(ofSize: 800, weight: .bold),
    .foregroundColor: NSColor(calibratedRed: 0.86, green: 0.92, blue: 0.98, alpha: 1)
])
let measured = mark.size()
mark.draw(at: NSPoint(x: (1024 - measured.width) / 2, y: (1024 - measured.height) / 2 + 53))
image.unlockFocus()
guard let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Could not render Gungun icon")
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
