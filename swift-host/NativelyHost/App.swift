// swift-host/NativelyHost/App.swift

import AppKit

@main
struct NativelyHostApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
