// swift-host/NativelyHost/ASPanel.swift

import AppKit

/// Custom NSPanel with display exclusion configured.
/// Window server sees "ASPanel" instead of Electron class names.
class ASPanel: NSPanel {
    
    override init(contentRect: NSRect, styleMask style: NSWindow.StyleMask, 
                  backing backingStoreType: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: style, backing: backingStoreType, defer: flag)
        configureDisplayExclusion()
        configureFloatingBehavior()
    }
    
    private func configureDisplayExclusion() {
        // Primary exclusion - prevents standard screen capture
        sharingType = .none
        
        // Additional hardening
        isExcludedFromWindowsMenu = true
    }
    
    private func configureFloatingBehavior() {
        // Float above other windows
        level = .floating
        
        // Workspace behavior
        collectionBehavior = [
            .canJoinAllSpaces,      // Visible on all desktops
            .fullScreenAuxiliary,   // Can appear over fullscreen apps
            .stationary,            // Excluded from Exposé
            .ignoresCycle           // Excluded from Cmd+Tab
        ]
        
        // Don't hide when app loses focus
        hidesOnDeactivate = false
        
        // Allow interaction without activating app
        styleMask.insert(.nonactivatingPanel)
    }
    
    /// Verify this window is excluded from screen capture
    func verifyExclusion() -> Bool {
        return DisplayExclusionManager.shared.verifyWindowExcluded(windowNumber: self.windowNumber)
    }
}
