// swift-host/NativelyHost/AppDelegate.swift

import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusBarManager: StatusBarManager?
    private var windowManager: WindowManager?
    private var ipcBridge: IPCBridge?
    private var embeddingService: ANEEmbeddingService?
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Hide dock icon (LSUIElement in Info.plist also does this)
        NSApp.setActivationPolicy(.accessory)
        
        // Initialize IPC first
        do {
            ipcBridge = try IPCBridge()
        } catch {
            print("Failed to initialize IPC bridge: \(error)")
        }
        
        // Initialize ANE embedding service
        initializeEmbeddingService()
        
        // Initialize window manager with IPC reference
        windowManager = WindowManager()
        windowManager?.ipcBridge = ipcBridge
        
        // Initialize status bar
        statusBarManager = StatusBarManager()
        
        // Setup backend notification handlers
        setupBackendHandlers()
        
        // Start backend process
        do {
            try ipcBridge?.startBackend()
        } catch {
            print("Failed to start backend: \(error)")
        }
        
        print("NativelyHost started")
    }
    
    private func initializeEmbeddingService() {
        print("AppDelegate: Initializing ANE embedding service...")
        embeddingService = ANEEmbeddingService()
        
        // Register embedding service with IPC bridge
        if let service = embeddingService, let bridge = ipcBridge {
            bridge.registerEmbeddingService(service)
            
            if service.hasRealModel {
                print("AppDelegate: Embedding service initialized with real model (ANE acceleration)")
            } else {
                print("AppDelegate: Embedding service initialized in mock mode (model not found)")
                print("AppDelegate: Run ./scripts/download-models.sh to download the embedding model")
            }
        }
    }
    
    private func setupBackendHandlers() {
        // Register handlers for specific backend notifications
        ipcBridge?.onNotification("app:stateChanged") { [weak self] params in
            self?.handleAppStateChanged(params)
        }
        
        ipcBridge?.onNotification("llm:token") { [weak self] params in
            // LLM tokens are forwarded to WebView via NotificationCenter
            // (already handled by IPCBridge posting to .backendNotification)
            _ = self // Silence warning
        }
        
        ipcBridge?.onNotification("overlay:show") { [weak self] _ in
            self?.windowManager?.showOverlay()
        }
        
        ipcBridge?.onNotification("overlay:hide") { [weak self] _ in
            self?.windowManager?.hideOverlay()
        }
    }
    
    private func handleAppStateChanged(_ params: [String: Any]) {
        // Handle app state changes from backend
        if let isUndetectable = params["isUndetectable"] as? Bool {
            print("AppDelegate: Undetectable mode changed to \(isUndetectable)")
        }
    }
    
    func applicationWillTerminate(_ notification: Notification) {
        ipcBridge?.stopBackend()
    }
    
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false // Keep running in menu bar
    }
}
