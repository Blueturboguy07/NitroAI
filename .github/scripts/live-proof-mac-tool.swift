// live-proof-mac-tool.swift — two helpers for live-proof-mac.sh. CI only (it moves the mouse).
//
//   drag <item> <target>   In the Finder window that shows both icons, drags the icon <item> onto the icon
//                          <target>, with the mouse, as a user does (a dmg window: NitroAI → Applications).
//   translocates <path>    Prints true or false: would macOS run this app translocated (from a read-only
//                          random path)? Asks Security's SecTranslocateURLShouldRunTranslocated.
//
// Build: swiftc -O live-proof-mac-tool.swift -o mac-tool
import Cocoa
import ApplicationServices

func die(_ m: String) -> Never {
  FileHandle.standardError.write((m + "\n").data(using: .utf8)!)
  exit(1)
}
func attr(_ e: AXUIElement, _ a: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil
}
func str(_ e: AXUIElement, _ a: String) -> String { (attr(e, a) as? String) ?? "" }
func kids(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func names(_ e: AXUIElement) -> Set<String> {
  Set([str(e, kAXTitleAttribute), str(e, kAXDescriptionAttribute), str(e, "AXFilename")])
}
// The first element (not a window) named one of `wanted`, of the given role if one is given.
func search(_ e: AXUIElement, _ wanted: Set<String>, role: String?, depth: Int = 0) -> AXUIElement? {
  if depth > 15 { return nil }
  let r = str(e, kAXRoleAttribute)
  if r != kAXWindowRole && (role == nil || r == role!) && !wanted.isDisjoint(with: names(e)) { return e }
  for c in kids(e) {
    if let f = search(c, wanted, role: role, depth: depth + 1) { return f }
  }
  return nil
}
func center(_ e: AXUIElement) -> CGPoint? {
  guard let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute) else { return nil }
  var pt = CGPoint.zero
  var sz = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &pt)
  AXValueGetValue(s as! AXValue, .cgSize, &sz)
  if sz.width <= 0 || sz.height <= 0 { return nil }
  return CGPoint(x: pt.x + sz.width / 2, y: pt.y + sz.height / 2)
}
func mouse(_ t: CGEventType, _ p: CGPoint) {
  CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(25_000)
}

let args = CommandLine.arguments
guard args.count >= 3 else { die("usage: drag <item> <target> | translocates <path>") }
switch args[1] {
case "translocates":
  typealias F = @convention(c) (CFURL, UnsafeMutablePointer<Bool>, UnsafeMutablePointer<Unmanaged<CFError>?>?) -> Bool
  guard let h = dlopen("/System/Library/Frameworks/Security.framework/Security", RTLD_NOW),
        let sym = dlsym(h, "SecTranslocateURLShouldRunTranslocated") else { die("no SecTranslocateURLShouldRunTranslocated") }
  var should = false
  guard unsafeBitCast(sym, to: F.self)(URL(fileURLWithPath: args[2]) as CFURL, &should, nil) else { die("the check failed") }
  print(should ? "true" : "false")

case "drag":
  guard args.count == 4 else { die("usage: drag <item> <target>") }
  if !AXIsProcessTrusted() { print("note: AXIsProcessTrusted() is false for this process; trying anyway") }
  guard let finder = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first else {
    die("the Finder does not run")
  }
  _ = finder.activate(options: [])
  let app = AXUIElementCreateApplication(finder.processIdentifier)
  let item: Set<String> = [args[2], args[2] + ".app"]
  let target: Set<String> = [args[3]]
  var from: CGPoint? = nil
  var to: CGPoint? = nil
  var seen: [String] = []
  for _ in 0..<40 { // the window can take a moment to show
    seen = []
    for w in kids(app) where str(w, kAXRoleAttribute) == kAXWindowRole {
      seen.append(str(w, kAXTitleAttribute))
      guard let a = search(w, item, role: kAXImageRole) ?? search(w, item, role: nil),
            let b = search(w, target, role: kAXImageRole) ?? search(w, target, role: nil) else { continue }
      from = center(a)
      to = center(b)
      if from != nil && to != nil { break }
    }
    if from != nil && to != nil { break }
    usleep(500_000)
  }
  guard let a = from, let b = to else {
    die("no Finder window shows both \(args[2]) and \(args[3]) (Finder windows: \(seen))")
  }
  print("drag \(args[2]) at \(Int(a.x)),\(Int(a.y)) onto \(args[3]) at \(Int(b.x)),\(Int(b.y))")
  _ = finder.activate(options: [])
  usleep(700_000)
  mouse(.mouseMoved, a)
  mouse(.leftMouseDown, a)
  usleep(300_000)
  for i in 1...40 {
    let t = CGFloat(i) / 40
    mouse(.leftMouseDragged, CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
  }
  usleep(600_000)
  mouse(.leftMouseUp, b)
  print("dropped")

default:
  die("unknown command \(args[1])")
}
