// swift-host/NativelyHost/WindowManager.swift

import AppKit
import WebKit

class WindowManager: WebViewManagerDelegate {
    private var overlayWindow: ASPanel?
    private var launcherWindow: ASWindow?
    private var overlayWebViewManager: WebViewManager?
    
    weak var ipcBridge: IPCBridge?
    
    init() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleShowOverlay),
            name: .showOverlay,
            object: nil
        )
        
        // Listen for backend notifications to forward to WebView
        setupBackendNotificationHandlers()
    }
    
    private func setupBackendNotificationHandlers() {
        // Register for backend state change notifications
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleBackendNotification(_:)),
            name: .backendNotification,
            object: nil
        )
    }
    
    @objc private func handleBackendNotification(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let channel = userInfo["channel"] as? String else {
            return
        }
        
        let data = userInfo["data"]
        overlayWebViewManager?.sendEvent(channel, data: data)
    }
    
    @objc private func handleShowOverlay() {
        showOverlay()
    }
    
    func showOverlay() {
        if overlayWindow == nil {
            overlayWindow = createOverlay()
            DisplayExclusionManager.shared.registerWindow(overlayWindow!)
        }
        overlayWindow?.makeKeyAndOrderFront(nil)
        
        // Verify exclusion after showing
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            if let window = self?.overlayWindow {
                let excluded = window.verifyExclusion()
                print("Overlay exclusion verified: \(excluded)")
            }
        }
    }
    
    func hideOverlay() {
        overlayWindow?.orderOut(nil)
    }
    
    private func createOverlay() -> ASPanel {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let screenFrame = screen.visibleFrame
        
        // Position in bottom-right corner
        let width: CGFloat = 400
        let height: CGFloat = 600
        let x = screenFrame.maxX - width - 20
        let y = screenFrame.minY + 20
        
        let panel = ASPanel(
            contentRect: NSRect(x: x, y: y, width: width, height: height),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "Overlay"
        panel.backgroundColor = .clear
        panel.isMovableByWindowBackground = true
        
        // Setup WebView
        overlayWebViewManager = WebViewManager()
        overlayWebViewManager?.delegate = self
        
        if let webView = overlayWebViewManager?.webView {
            webView.frame = panel.contentView?.bounds ?? .zero
            webView.autoresizingMask = [.width, .height]
            panel.contentView?.addSubview(webView)
        }
        
        overlayWebViewManager?.loadLocalApp()
        
        return panel
    }
    
    func showLauncher() {
        if launcherWindow == nil {
            launcherWindow = createLauncher()
            DisplayExclusionManager.shared.registerWindow(launcherWindow!)
        }
        launcherWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    
    private func createLauncher() -> ASWindow {
        let window = ASWindow(
            contentRect: NSRect(x: 200, y: 200, width: 800, height: 600),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Natively"
        window.center()
        return window
    }
    
    // MARK: - WebViewManagerDelegate
    
    func webViewManager(_ manager: WebViewManager, didReceiveMessage channel: String, data: Any?) {
        // Forward to backend via IPC
        Task {
            do {
                try ipcBridge?.notify(channel, params: data as? [String: Any])
            } catch {
                print("WindowManager: Failed to forward message: \(error)")
            }
        }
    }
    
    func webViewManager(_ manager: WebViewManager, didInvoke channel: String, data: Any?, replyHandler: @escaping (Any?) -> Void) {
        // Forward to backend and return response
        Task {
            do {
                let result = try await ipcBridge?.call(channel, params: data as? [String: Any])
                DispatchQueue.main.async {
                    replyHandler(result)
                }
            } catch {
                print("WindowManager: Invoke failed: \(error)")
                DispatchQueue.main.async {
                    replyHandler(nil)
                }
            }
        }
    }
    
    // MARK: - Send events to WebView
    
    func sendEventToWebView(_ channel: String, data: Any?) {
        overlayWebViewManager?.sendEvent(channel, data: data)
    }
}

// MARK: - Notification Names

extension Notification.Name {
    static let backendNotification = Notification.Name("backendNotification")
}
