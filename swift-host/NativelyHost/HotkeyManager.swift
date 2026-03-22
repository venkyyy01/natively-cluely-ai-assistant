// swift-host/NativelyHost/HotkeyManager.swift
//
// Global hotkey registration using Carbon Event APIs.
// Registers system-wide keyboard shortcuts for toggling the overlay.
//
// Usage:
//   let manager = HotkeyManager()
//   manager.registerHotkey(.init(keyCode: 49, modifiers: [.command, .shift])) {
//       // Handle Cmd+Shift+Space
//   }

import AppKit
import Carbon

/// Configuration for a global hotkey
struct HotkeyConfig: Hashable, Equatable {
    let keyCode: UInt32
    let modifiers: NSEvent.ModifierFlags
    
    // Custom Hashable conformance since ModifierFlags doesn't conform
    func hash(into hasher: inout Hasher) {
        hasher.combine(keyCode)
        hasher.combine(modifiers.rawValue)
    }
    
    static func == (lhs: HotkeyConfig, rhs: HotkeyConfig) -> Bool {
        return lhs.keyCode == rhs.keyCode && lhs.modifiers == rhs.modifiers
    }
    
    /// Cmd+Shift+Space (default toggle hotkey)
    static let toggleOverlay = HotkeyConfig(
        keyCode: UInt32(kVK_Space),
        modifiers: [.command, .shift]
    )
    
    /// Escape key (dismiss)
    static let dismiss = HotkeyConfig(
        keyCode: UInt32(kVK_Escape),
        modifiers: []
    )
    
    /// Convert NSEvent.ModifierFlags to Carbon modifier mask
    var carbonModifiers: UInt32 {
        var carbonMods: UInt32 = 0
        if modifiers.contains(.command) { carbonMods |= UInt32(cmdKey) }
        if modifiers.contains(.option) { carbonMods |= UInt32(optionKey) }
        if modifiers.contains(.control) { carbonMods |= UInt32(controlKey) }
        if modifiers.contains(.shift) { carbonMods |= UInt32(shiftKey) }
        return carbonMods
    }
}

/// Manages global hotkey registration using Carbon Event APIs
class HotkeyManager {
    typealias HotkeyHandler = () -> Void
    
    private var registeredHotkeys: [UInt32: (ref: EventHotKeyRef?, handler: HotkeyHandler)] = [:]
    private var nextHotkeyId: UInt32 = 1
    private var eventHandler: EventHandlerRef?
    
    // Singleton for Carbon event callback access
    private static var shared: HotkeyManager?
    
    init() {
        HotkeyManager.shared = self
        installEventHandler()
    }
    
    deinit {
        unregisterAll()
        if let handler = eventHandler {
            RemoveEventHandler(handler)
        }
    }
    
    // MARK: - Public API
    
    /// Register a global hotkey with a handler
    /// - Parameters:
    ///   - config: The hotkey configuration (key code and modifiers)
    ///   - handler: Closure to call when hotkey is pressed
    /// - Returns: Hotkey ID for later unregistration, or nil if failed
    @discardableResult
    func registerHotkey(_ config: HotkeyConfig, handler: @escaping HotkeyHandler) -> UInt32? {
        let hotkeyId = nextHotkeyId
        nextHotkeyId += 1
        
        var hotkeyRef: EventHotKeyRef?
        let hotkeyID = EventHotKeyID(signature: OSType(0x4E4C5459), id: hotkeyId) // "NLTY"
        
        let status = RegisterEventHotKey(
            config.keyCode,
            config.carbonModifiers,
            hotkeyID,
            GetApplicationEventTarget(),
            0,
            &hotkeyRef
        )
        
        guard status == noErr else {
            print("HotkeyManager: Failed to register hotkey (error: \(status))")
            return nil
        }
        
        registeredHotkeys[hotkeyId] = (ref: hotkeyRef, handler: handler)
        print("HotkeyManager: Registered hotkey \(hotkeyId) (keyCode: \(config.keyCode), mods: \(config.modifiers.rawValue))")
        
        return hotkeyId
    }
    
    /// Unregister a specific hotkey by ID
    func unregisterHotkey(_ hotkeyId: UInt32) {
        guard let entry = registeredHotkeys.removeValue(forKey: hotkeyId) else {
            return
        }
        
        if let ref = entry.ref {
            UnregisterEventHotKey(ref)
        }
        
        print("HotkeyManager: Unregistered hotkey \(hotkeyId)")
    }
    
    /// Unregister all hotkeys
    func unregisterAll() {
        for (id, entry) in registeredHotkeys {
            if let ref = entry.ref {
                UnregisterEventHotKey(ref)
            }
            print("HotkeyManager: Unregistered hotkey \(id)")
        }
        registeredHotkeys.removeAll()
    }
    
    /// Register the default toggle overlay hotkey (Cmd+Shift+Space)
    @discardableResult
    func registerDefaultToggleHotkey(handler: @escaping HotkeyHandler) -> UInt32? {
        return registerHotkey(.toggleOverlay, handler: handler)
    }
    
    // MARK: - Private Methods
    
    private func installEventHandler() {
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        
        let callback: EventHandlerUPP = { _, event, _ in
            var hotkeyID = EventHotKeyID()
            let status = GetEventParameter(
                event,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &hotkeyID
            )
            
            guard status == noErr else {
                return OSStatus(eventNotHandledErr)
            }
            
            // Dispatch to handler on main thread
            DispatchQueue.main.async {
                if let entry = HotkeyManager.shared?.registeredHotkeys[hotkeyID.id] {
                    entry.handler()
                }
            }
            
            return noErr
        }
        
        InstallEventHandler(
            GetApplicationEventTarget(),
            callback,
            1,
            &eventType,
            nil,
            &eventHandler
        )
    }
    
    // MARK: - Convenience Methods
    
    /// Check if a hotkey is available (not registered by another app)
    func isHotkeyAvailable(_ config: HotkeyConfig) -> Bool {
        var hotkeyRef: EventHotKeyRef?
        let hotkeyID = EventHotKeyID(signature: OSType(0x54455354), id: 0xFFFF) // "TEST"
        
        let status = RegisterEventHotKey(
            config.keyCode,
            config.carbonModifiers,
            hotkeyID,
            GetApplicationEventTarget(),
            0,
            &hotkeyRef
        )
        
        if status == noErr, let ref = hotkeyRef {
            UnregisterEventHotKey(ref)
            return true
        }
        
        return false
    }
    
    /// Get human-readable description of a hotkey
    func description(for config: HotkeyConfig) -> String {
        var parts: [String] = []
        
        if config.modifiers.contains(.command) { parts.append("⌘") }
        if config.modifiers.contains(.shift) { parts.append("⇧") }
        if config.modifiers.contains(.option) { parts.append("⌥") }
        if config.modifiers.contains(.control) { parts.append("⌃") }
        
        // Map common key codes to symbols
        let keyName: String
        switch Int(config.keyCode) {
        case kVK_Space: keyName = "Space"
        case kVK_Return: keyName = "↩"
        case kVK_Escape: keyName = "⎋"
        case kVK_Tab: keyName = "⇥"
        case kVK_Delete: keyName = "⌫"
        case kVK_ANSI_A...kVK_ANSI_Z:
            // Convert key code to letter
            let offset = config.keyCode - UInt32(kVK_ANSI_A)
            keyName = String(UnicodeScalar(UInt8(65 + offset)))
        default:
            keyName = "Key\(config.keyCode)"
        }
        
        parts.append(keyName)
        return parts.joined()
    }
}

// MARK: - Key Code Constants Extension

extension HotkeyConfig {
    /// Common key codes for convenience
    static func withKey(_ keyCode: Int, modifiers: NSEvent.ModifierFlags = []) -> HotkeyConfig {
        HotkeyConfig(keyCode: UInt32(keyCode), modifiers: modifiers)
    }
}
