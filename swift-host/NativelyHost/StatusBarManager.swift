// swift-host/NativelyHost/StatusBarManager.swift

import AppKit

class StatusBarManager {
    private var statusItem: NSStatusItem?
    
    init() {
        setupStatusBar()
    }
    
    private func setupStatusBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        
        if let button = statusItem?.button {
            button.image = NSImage(systemSymbolName: "circle.fill", accessibilityDescription: "Natively")
        }
        
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Show Overlay", action: #selector(showOverlay), keyEquivalent: "o"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
        
        statusItem?.menu = menu
    }
    
    @objc private func showOverlay() {
        NotificationCenter.default.post(name: .showOverlay, object: nil)
    }
    
    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

extension Notification.Name {
    static let showOverlay = Notification.Name("showOverlay")
}
