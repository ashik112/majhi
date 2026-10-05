/**
 * The source of majhi's own notifier app, built on the owner's Mac by `majhiNotifier.ts`. A raw string, so
 * Swift's backslashes stay as written.
 */
export const NOTIFIER_SWIFT = String.raw`import AppKit
import UserNotifications

// majhi's notifier. post shows one notification, status only reads the permission, authorize asks
// macOS for it and waits for the owner's answer for as long as it takes (ending this program while the
// question is on screen makes macOS count it as a No). With no arguments (macOS starts the app again
// when a notification is clicked) it waits for the click.
// Exit codes: 0 done, 2 bad use, 3 notifications are off for this app, 4 anything else,
// 5 the owner has not been asked yet.

func finish(_ code: Int32, _ note: String? = nil) -> Never {
    if let note = note { FileHandle.standardError.write(Data((note + "\n").utf8)) }
    exit(code)
}

func webURL(_ text: String) -> URL? {
    guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
        return nil
    }
    return url
}

final class Delegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        if let text = response.notification.request.content.userInfo["url"] as? String, let url = webURL(text) {
            NSWorkspace.shared.open(url)
        }
        done()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { exit(0) }
    }
}

var options: [String: String] = [:]
var flags = Set<String>()
var args = Array(CommandLine.arguments.dropFirst())
let command = args.isEmpty || args[0].hasPrefix("-") ? "listen" : args.removeFirst()
var index = 0
while index < args.count {
    let name = args[index]
    if name == "--sound" {
        flags.insert("sound")
        index += 1
    } else if name.hasPrefix("--"), index + 1 < args.count {
        options[String(name.dropFirst(2))] = args[index + 1]
        index += 2
    } else {
        finish(2, "bad argument \(name)")
    }
}

let delegate = Delegate()
let center = UNUserNotificationCenter.current()
center.delegate = delegate
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

func authorized(_ status: UNAuthorizationStatus) -> Bool {
    return status == .authorized || status == .provisional
}

func post() {
    center.getNotificationSettings { settings in
        let send = {
            let content = UNMutableNotificationContent()
            content.title = options["title"] ?? "majhi"
            content.body = options["message"] ?? ""
            content.threadIdentifier = "majhi"
            if flags.contains("sound") { content.sound = .default }
            if let text = options["url"], webURL(text) != nil { content.userInfo = ["url": text] }
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            center.add(request) { error in
                if let error = error { finish(4, "could not post: \(error.localizedDescription)") }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { exit(0) }
            }
        }
        if settings.authorizationStatus == .denied { finish(3, "Notifications are turned off for this application") }
        if authorized(settings.authorizationStatus) { return send() }
        // Never asks here: this program is stopped after a few seconds, and stopping it with the question
        // on screen would count as a No. The helper runs authorize for that.
        finish(5, "Notifications have not been allowed yet")
    }
}

switch command {
case "post":
    post()
case "authorize":
    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
        if let error = error as NSError? { finish(4, "error \(error.domain) \(error.code): \(error.localizedDescription)") }
        finish(granted ? 0 : 3, granted ? "granted" : "not granted")
    }
case "status":
    center.getNotificationSettings { settings in
        switch settings.authorizationStatus {
        case .denied: finish(3, "denied")
        case .notDetermined: finish(5, "not-determined")
        default: finish(0, "authorized")
        }
    }
case "listen":
    // Started by a click: the delegate gets the response a moment after launch.
    DispatchQueue.main.asyncAfter(deadline: .now() + 20) { exit(0) }
default:
    finish(2, "unknown command \(command)")
}
app.run()
`;
