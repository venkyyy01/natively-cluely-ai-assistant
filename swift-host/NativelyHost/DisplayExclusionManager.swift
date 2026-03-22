// swift-host/NativelyHost/DisplayExclusionManager.swift

import AppKit
import CoreGraphics

/// Manages and verifies display exclusion for all app windows.
class DisplayExclusionManager {
    static let shared = DisplayExclusionManager()
    
    private var managedWindows: [Int] = []
    
    private init() {}
    
    /// Register a window for exclusion tracking
    func registerWindow(_ window: NSWindow) {
        managedWindows.append(window.windowNumber)
    }
    
    /// Unregister a window
    func unregisterWindow(_ window: NSWindow) {
        managedWindows.removeAll { $0 == window.windowNumber }
    }
    
    /// Verify a specific window is not in the capture list
    func verifyWindowExcluded(windowNumber: Int) -> Bool {
        guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
            return true // Can't get list, assume excluded
        }
        
        for window in windowList {
            if let wNum = window[kCGWindowNumber as String] as? Int, wNum == windowNumber {
                // Window found in capture list - NOT excluded
                return false
            }
        }
        
        // Window not in capture list - properly excluded
        return true
    }
    
    /// Verify all managed windows are excluded
    func verifyAllExcluded() -> Bool {
        guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
            return true
        }
        
        let windowNumbers = Set(windowList.compactMap { $0[kCGWindowNumber as String] as? Int })
        let leakedWindows = managedWindows.filter { windowNumbers.contains($0) }
        
        if !leakedWindows.isEmpty {
            print("DisplayExclusionManager: WARNING - \(leakedWindows.count) windows leaking to capture")
            return false
        }
        
        return true
    }
    
    /// Debug: Print all windows visible to capture APIs
    func debugPrintCaptureList() {
        guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
            print("Could not get window list")
            return
        }
        
        print("=== Windows visible to capture ===")
        for window in windowList {
            let name = window[kCGWindowOwnerName as String] as? String ?? "Unknown"
            let num = window[kCGWindowNumber as String] as? Int ?? 0
            let layer = window[kCGWindowLayer as String] as? Int ?? 0
            print("  [\(num)] \(name) (layer: \(layer))")
        }
        print("=== Our managed windows: \(managedWindows) ===")
    }
}
