// swift-host/NativelyHost/ASWindow.swift

import AppKit

/// Custom NSWindow with display exclusion configured.
/// Used for main windows that need capture protection.
class ASWindow: NSWindow {
    
    override init(contentRect: NSRect, styleMask style: NSWindow.StyleMask, 
                  backing backingStoreType: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: style, backing: backingStoreType, defer: flag)
        configureDisplayExclusion()
    }
    
    private func configureDisplayExclusion() {
        // Primary exclusion - prevents standard screen capture
        sharingType = .none
        
        // Additional hardening
        isExcludedFromWindowsMenu = true
        
        // Workspace behavior
        collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary
        ]
    }
    
    /// Verify this window is excluded from screen capture
    func verifyExclusion() -> Bool {
        return DisplayExclusionManager.shared.verifyWindowExcluded(windowNumber: self.windowNumber)
    }
}
