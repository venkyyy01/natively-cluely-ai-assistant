#!/usr/bin/env swift
// verify-cg-window-list.swift
// Check if Natively windows appear in CGWindowListCopyWindowInfo
// This does NOT require Screen Recording permission.
// NOTE: This tests the LEGACY API, not SCK. But it shows sharing_state.

import CoreGraphics
import Foundation

func main() {
    print("=== CGWindowList Verification (no TCC required) ===")
    print("macOS version: \(ProcessInfo.processInfo.operatingSystemVersionString)")
    print("")

    guard let windowList = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else {
        print("❌ CGWindowListCopyWindowInfo returned nil")
        return
    }

    print("Total windows in CGWindowList: \(windowList.count)")
    print("")

    // Find Natively/Cluely/Electron windows
    let suspectWindows = windowList.filter { info in
        let ownerName = (info[kCGWindowOwnerName as String] as? String ?? "").lowercased()
        return ownerName.contains("natively")
            || ownerName.contains("cluely")
            || ownerName.contains("electron")
    }

    if suspectWindows.isEmpty {
        print("✅ No Natively/Cluely/Electron windows found in CGWindowList")
        print("   (App may not be running, or windows are excluded from CG enumeration too)")
    } else {
        print("Found \(suspectWindows.count) Natively/Cluely/Electron windows:")
        print("")
        for info in suspectWindows {
            let windowNumber = info[kCGWindowNumber as String] as? Int ?? -1
            let ownerName = info[kCGWindowOwnerName as String] as? String ?? "?"
            let windowName = info[kCGWindowName as String] as? String ?? "(no title)"
            let sharingState = info[kCGWindowSharingState as String] as? Int ?? -1
            let isOnScreen = info[kCGWindowIsOnscreen as String] as? Bool ?? false
            let alpha = info[kCGWindowAlpha as String] as? Double ?? 1.0
            let layer = info[kCGWindowLayer as String] as? Int ?? 0

            // kCGWindowSharingState values:
            // 0 = kCGWindowSharingNone (not shared/captured)
            // 1 = kCGWindowSharingReadOnly
            // 2 = kCGWindowSharingReadWrite
            let sharingDesc: String
            switch sharingState {
            case 0: sharingDesc = "NONE (protected ✅)"
            case 1: sharingDesc = "ReadOnly (VISIBLE ❌)"
            case 2: sharingDesc = "ReadWrite (VISIBLE ❌)"
            default: sharingDesc = "Unknown(\(sharingState))"
            }

            print("   Window #\(windowNumber)")
            print("     Owner: \(ownerName)")
            print("     Title: \(windowName)")
            print("     Sharing: \(sharingDesc)")
            print("     OnScreen: \(isOnScreen)")
            print("     Alpha: \(alpha)")
            print("     Layer: \(layer)")
            print("")
        }
    }

    // Summary
    let visibleToCapture = suspectWindows.filter { info in
        let sharingState = info[kCGWindowSharingState as String] as? Int ?? -1
        return sharingState != 0
    }

    print("--- Summary ---")
    print("Windows with sharingState=0 (protected): \(suspectWindows.count - visibleToCapture.count)")
    print("Windows with sharingState!=0 (capturable): \(visibleToCapture.count)")
    print("")
    if visibleToCapture.isEmpty && !suspectWindows.isEmpty {
        print("✅ All Natively windows have sharingState=0 (kCGWindowSharingNone)")
        print("   This means setContentProtection/sharingType=.none IS applied.")
        print("")
        print("⚠️  BUT: On macOS 15+, sharingState=0 alone does NOT guarantee SCK invisibility.")
        print("   SCK may still enumerate windows with sharingState=0 unless the CGS")
        print("   exclusion tag (bit 3) is also set. To verify SCK invisibility,")
        print("   grant Screen Recording permission and run verify-sck-invisibility.swift")
    } else if !visibleToCapture.isEmpty {
        print("❌ Some windows have sharingState != 0 — they ARE capturable!")
    }
}

main()
