#!/usr/bin/env swift
// verify-sck-invisibility.swift
// Run this WHILE the app is running to verify windows are actually invisible to SCK.
// Usage: swift scripts/verify-sck-invisibility.swift
//
// This is the DEFINITIVE test. If this script lists any "Natively" windows,
// the CGSSetWindowTags approach is NOT working on your macOS version.

import ScreenCaptureKit
import Foundation

@available(macOS 12.3, *)
func main() async {
    print("=== SCK Invisibility Verification ===")
    print("macOS version: \(ProcessInfo.processInfo.operatingSystemVersionString)")
    print("")

    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

        let nativelyWindows = content.windows.filter { window in
            let app = window.owningApplication
            let name = app?.applicationName ?? ""
            let bundleId = app?.bundleIdentifier ?? ""
            return name.lowercased().contains("natively")
                || bundleId.lowercased().contains("natively")
                || name.lowercased().contains("cluely")
                || bundleId.lowercased().contains("cluely")
        }

        print("Total windows visible to SCK: \(content.windows.count)")
        print("Natively/Cluely windows visible to SCK: \(nativelyWindows.count)")
        print("")

        if nativelyWindows.isEmpty {
            print("✅ PASS: No Natively windows visible to ScreenCaptureKit")
            print("   The overlay IS invisible to screen-share apps.")
        } else {
            print("❌ FAIL: Natively windows ARE visible to ScreenCaptureKit!")
            print("   These windows WILL appear in screen shares (Zoom, Meet, Teams, OBS):")
            print("")
            for window in nativelyWindows {
                let app = window.owningApplication
                print("   - Window ID: \(window.windowID)")
                print("     Title: \(window.title ?? "(no title)")")
                print("     App: \(app?.applicationName ?? "(unknown)")")
                print("     Bundle: \(app?.bundleIdentifier ?? "(unknown)")")
                print("     On screen: \(window.isOnScreen)")
                print("     Frame: \(window.frame)")
                print("")
            }
            print("   CGSSetWindowTags bit-3 is NOT working on this macOS version.")
            print("   Virtual display isolation is required as the primary mechanism.")
        }

        // Also check all windows for any that might be the app under a disguise name
        print("")
        print("--- All Electron/unknown windows (for disguise detection) ---")
        let suspectWindows = content.windows.filter { window in
            let app = window.owningApplication
            let name = app?.applicationName ?? ""
            return name.lowercased().contains("electron")
                || name.lowercased().contains("helper")
                || (name.isEmpty && window.isOnScreen)
        }
        for window in suspectWindows.prefix(10) {
            let app = window.owningApplication
            print("   Window ID: \(window.windowID) | App: \(app?.applicationName ?? "?") | Title: \(window.title ?? "?") | OnScreen: \(window.isOnScreen)")
        }

    } catch {
        print("❌ ERROR: Failed to query SCShareableContent: \(error)")
        print("   Make sure Screen Recording permission is granted to Terminal/your IDE.")
    }
}

if #available(macOS 12.3, *) {
    let semaphore = DispatchSemaphore(value: 0)
    Task {
        await main()
        semaphore.signal()
    }
    semaphore.wait()
} else {
    print("This script requires macOS 12.3+")
}
