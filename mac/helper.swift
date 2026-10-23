// Blots Mac helper: reads apps through the macOS accessibility tree and acts on numbered elements.
// Line-delimited JSON on stdin/stdout: {"id":1,"cmd":"read","owner":"blot","app":"com.apple.TextEdit"}.
// Element numbers refer to the owner's latest read, like numbered browser elements.
import AppKit
import ApplicationServices
import Foundation

struct Snapshot { let pid: pid_t; let elements: [AXUIElement] }
var snapshots: [String: Snapshot] = [:]

let interactive: Set<String> = ["AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXLink", "AXComboBox", "AXSlider", "AXMenuItem", "AXDisclosureTriangle", "AXIncrementor", "AXSearchField"]

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}
func text(_ el: AXUIElement, _ name: String) -> String? {
  guard let s = attr(el, name) as? String else { return nil }
  let t = s.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " ")
  return t.isEmpty ? nil : String(t.prefix(160))
}
func frame(_ el: AXUIElement) -> [String: Double]? {
  guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
  var point = CGPoint.zero, size = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &point); AXValueGetValue(s as! AXValue, .cgSize, &size)
  return ["x": point.x, "y": point.y, "width": size.width, "height": size.height]
}
func secure(_ el: AXUIElement) -> Bool { text(el, kAXSubroleAttribute) == "AXSecureTextField" }

func app(_ bundle: String) throws -> NSRunningApplication {
  guard let found = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first else { throw Fail("\(bundle) is not running. Open it first.") }
  return found
}
struct Fail: Error { let message: String; init(_ m: String) { message = m } }

func read(owner: String, bundle: String) throws -> [String: Any] {
  let running = try app(bundle), root = AXUIElementCreateApplication(running.processIdentifier)
  let window = (attr(root, kAXFocusedWindowAttribute) ?? (attr(root, kAXWindowsAttribute) as? [AnyObject])?.first)
  guard let window else { throw Fail("\(running.localizedName ?? bundle) has no open window.") }
  let win = window as! AXUIElement
  var elements: [AXUIElement] = [], lines: [String] = [], visited = 0
  func walk(_ el: AXUIElement, _ depth: Int) {
    visited += 1
    if visited > 4000 || depth > 40 || elements.count >= 150 || lines.count >= 400 { return }
    let role = text(el, kAXRoleAttribute) ?? ""
    let label = text(el, kAXTitleAttribute) ?? text(el, kAXDescriptionAttribute) ?? text(el, kAXHelpAttribute)
    if role == "AXRow" {
      // A row is one target: its cell texts become its label instead of separate numbers.
      var parts: [String] = []
      func gather(_ e: AXUIElement, _ d: Int) {
        if parts.count >= 4 || d > 6 { return }
        if let v = text(e, kAXValueAttribute) ?? text(e, kAXTitleAttribute), ["AXStaticText", "AXTextField", "AXCell"].contains(text(e, kAXRoleAttribute) ?? "") { parts.append(v) }
        for c in (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { gather(c, d + 1) }
      }
      gather(el, 0)
      lines.append("[\(elements.count)] AXRow \"\(parts.joined(separator: " · "))\"")
      elements.append(el); return
    }
    if interactive.contains(role) {
      let value = secure(el) ? "(password field; never typed into)" : text(el, kAXValueAttribute)
      let enabled = (attr(el, kAXEnabledAttribute) as? Bool) ?? true
      lines.append("[\(elements.count)] \(role)\(label.map { " \"\($0)\"" } ?? "")\(value.map { " = \"\($0)\"" } ?? "")\(enabled ? "" : " (disabled)")")
      elements.append(el)
    } else if role == "AXStaticText", let value = text(el, kAXValueAttribute) ?? label {
      lines.append("  \(value)")
    }
    for child in (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { walk(child, depth + 1) }
  }
  walk(win, 0)
  snapshots[owner] = Snapshot(pid: running.processIdentifier, elements: elements)
  return ["app": running.localizedName ?? bundle, "window": text(win, kAXTitleAttribute) ?? "", "elements": lines.joined(separator: "\n")]
}

func element(_ owner: String, _ n: Int) throws -> (Snapshot, AXUIElement) {
  guard let snap = snapshots[owner] else { throw Fail("Call mac_read first.") }
  guard n >= 0, n < snap.elements.count else { throw Fail("Use an element number from the latest mac_read.") }
  return (snap, snap.elements[n])
}
func center(_ el: AXUIElement) -> CGPoint? {
  guard let f = frame(el) else { return nil }
  return CGPoint(x: f["x"]! + f["width"]! / 2, y: f["y"]! + f["height"]! / 2)
}
func click(_ point: CGPoint) {
  for type in [CGEventType.leftMouseDown, .leftMouseUp] { CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap) }
}
func activate(_ pid: pid_t) { NSRunningApplication(processIdentifier: pid)?.activate(); usleep(200_000) }

func press(owner: String, n: Int) throws -> [String: Any] {
  let (snap, el) = try element(owner, n)
  AXUIElementPerformAction(el, "AXScrollToVisible" as CFString)
  if AXUIElementPerformAction(el, kAXPressAction as CFString) != .success {
    // Some controls only respond to a real click; that needs the app in front.
    guard let point = center(el) else { throw Fail("This element cannot be pressed.") }
    activate(snap.pid); click(point)
  }
  return ["pressed": n, "frame": frame(el) as Any]
}

func type(owner: String, n: Int, value: String) throws -> [String: Any] {
  let (snap, el) = try element(owner, n)
  if secure(el) { throw Fail("Blots never types into password fields. Ask the user to do it.") }
  AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  if AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFString) != .success {
    activate(snap.pid)
    for scalar in value.utf16.chunked(20) {
      for down in [true, false] {
        let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
        event?.keyboardSetUnicodeString(stringLength: scalar.count, unicodeString: scalar)
        event?.post(tap: .cghidEventTap)
      }
    }
  }
  return ["typed": n, "frame": frame(el) as Any]
}
extension String.UTF16View { func chunked(_ size: Int) -> [[UniChar]] { stride(from: 0, to: count, by: size).map { Array(Array(self)[$0..<Swift.min($0 + size, count)]) } } }

let keyCodes: [String: CGKeyCode] = ["Return": 36, "Tab": 48, "Escape": 53, "Delete": 51, "Up": 126, "Down": 125, "Left": 123, "Right": 124, "Space": 49,
  "a": 0, "c": 8, "f": 3, "l": 37, "n": 45, "s": 1, "t": 17, "v": 9, "w": 13, "z": 6]
func key(bundle: String, combo: String) throws -> [String: Any] {
  let running = try app(bundle), parts = combo.split(separator: "+").map(String.init)
  guard let last = parts.last, let code = keyCodes[last] else { throw Fail("Unsupported key \(combo).") }
  var flags: CGEventFlags = []
  for part in parts.dropLast() { switch part { case "cmd": flags.insert(.maskCommand); case "shift": flags.insert(.maskShift); case "option": flags.insert(.maskAlternate); case "ctrl": flags.insert(.maskControl); default: throw Fail("Unsupported modifier \(part).") } }
  activate(running.processIdentifier)
  for down in [true, false] { let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down); event?.flags = flags; event?.post(tap: .cghidEventTap) }
  return ["pressed": combo]
}

func open(bundle: String) throws -> [String: Any] {
  guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { throw Fail("\(bundle) is not installed.") }
  let done = DispatchSemaphore(value: 0); var failure: Error?
  NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, error in failure = error; done.signal() }
  if done.wait(timeout: .now() + 15) == .timedOut { throw Fail("\(bundle) did not open in time.") }
  if let failure { throw failure }
  usleep(800_000)
  return ["opened": bundle]
}

func window(bundle: String) throws -> [String: Any] {
  let pid = try app(bundle).processIdentifier
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  guard let info = list.first(where: { ($0[kCGWindowOwnerPID as String] as? pid_t) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }), let id = info[kCGWindowNumber as String] as? Int else { throw Fail("No visible window to capture.") }
  return ["windowId": id]
}

func handle(_ req: [String: Any]) throws -> Any {
  let owner = req["owner"] as? String ?? "", bundle = req["app"] as? String ?? ""
  switch req["cmd"] as? String {
  case "status":
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: req["prompt"] as? Bool ?? false] as CFDictionary
    let accessibility = AXIsProcessTrustedWithOptions(options), screen = CGPreflightScreenCaptureAccess()
    if req["prompt"] as? Bool == true && !screen { CGRequestScreenCaptureAccess() }
    return ["accessibility": accessibility, "screenRecording": screen]
  case "apps":
    return NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil }.map { ["app": $0.bundleIdentifier!, "name": $0.localizedName ?? ""] }
  case "open": return try open(bundle: bundle)
  case "read": return try read(owner: owner, bundle: bundle)
  case "press": return try press(owner: owner, n: req["element"] as? Int ?? -1)
  case "type": return try type(owner: owner, n: req["element"] as? Int ?? -1, value: req["text"] as? String ?? "")
  case "key": return try key(bundle: bundle, combo: req["key"] as? String ?? "")
  case "window": return try window(bundle: bundle)
  case "locate":
    let (_, el) = try element(owner, req["element"] as? Int ?? -1)
    AXUIElementPerformAction(el, "AXScrollToVisible" as CFString)
    return ["frame": frame(el) as Any]
  default: throw Fail("Unknown command.")
  }
}

setvbuf(stdout, nil, _IOLBF, 0)
while let line = readLine() {
  guard let data = line.data(using: .utf8), let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
  var reply: [String: Any] = ["id": req["id"] ?? 0]
  do { reply["result"] = try handle(req) } catch let fail as Fail { reply["error"] = fail.message } catch { reply["error"] = error.localizedDescription }
  if let out = try? JSONSerialization.data(withJSONObject: reply), let s = String(data: out, encoding: .utf8) { print(s) }
}
