// swift-host/NativelyHost/ScreenCapture.swift
//
// Screenshot functionality using ScreenCaptureKit.
// Excludes own windows from capture to maintain stealth.
//
// Usage:
//   let capture = ScreenCapture()
//   let image = try await capture.captureScreen()
//   let windowImage = try await capture.captureWindow(windowID)

import AppKit
import ScreenCaptureKit
import UniformTypeIdentifiers

/// Handles screen capture with automatic exclusion of app windows
@available(macOS 12.3, *)
class ScreenCapture {
    
    /// Errors that can occur during screen capture
    enum CaptureError: Error {
        case noDisplayFound
        case captureNotPermitted
        case captureFilterCreationFailed
        case imageCreationFailed
        case windowNotFound
        case unsupportedOS
    }
    
    /// Configuration for screen capture
    struct CaptureConfig {
        var excludeOwnWindows: Bool = true
        var capturesCursor: Bool = false
        var scaleFactor: CGFloat = 1.0
    }
    
    private var config: CaptureConfig
    
    init(config: CaptureConfig = CaptureConfig()) {
        self.config = config
    }
    
    // MARK: - Public API
    
    /// Capture the entire screen, excluding own windows
    /// - Returns: NSImage of the captured screen
    func captureScreen() async throws -> NSImage {
        // Get shareable content
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        
        guard let display = content.displays.first else {
            throw CaptureError.noDisplayFound
        }
        
        // Create filter excluding our windows
        let filter = try await createFilter(for: display, content: content)
        
        // Configure capture
        let streamConfig = SCStreamConfiguration()
        streamConfig.width = Int(CGFloat(display.width) * config.scaleFactor)
        streamConfig.height = Int(CGFloat(display.height) * config.scaleFactor)
        streamConfig.showsCursor = config.capturesCursor
        streamConfig.pixelFormat = kCVPixelFormatType_32BGRA
        
        // Capture single frame
        let image = try await captureSingleFrame(filter: filter, config: streamConfig)
        return image
    }
    
    /// Capture a specific window by window ID
    /// - Parameter windowID: The CGWindowID of the window to capture
    /// - Returns: NSImage of the captured window
    func captureWindow(_ windowID: CGWindowID) async throws -> NSImage {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
            throw CaptureError.windowNotFound
        }
        
        let filter = SCContentFilter(desktopIndependentWindow: window)
        
        let streamConfig = SCStreamConfiguration()
        streamConfig.width = Int(window.frame.width * config.scaleFactor)
        streamConfig.height = Int(window.frame.height * config.scaleFactor)
        streamConfig.showsCursor = config.capturesCursor
        streamConfig.pixelFormat = kCVPixelFormatType_32BGRA
        
        let image = try await captureSingleFrame(filter: filter, config: streamConfig)
        return image
    }
    
    /// Capture a specific region of the screen
    /// - Parameter rect: The region to capture in screen coordinates
    /// - Returns: NSImage of the captured region
    func captureRegion(_ rect: CGRect) async throws -> NSImage {
        let fullScreen = try await captureScreen()
        
        // Crop to region
        guard let cgImage = fullScreen.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw CaptureError.imageCreationFailed
        }
        
        // Convert rect to image coordinates (flip Y)
        let screenHeight = CGFloat(cgImage.height) / config.scaleFactor
        let imageRect = CGRect(
            x: rect.origin.x * config.scaleFactor,
            y: (screenHeight - rect.origin.y - rect.height) * config.scaleFactor,
            width: rect.width * config.scaleFactor,
            height: rect.height * config.scaleFactor
        )
        
        guard let cropped = cgImage.cropping(to: imageRect) else {
            throw CaptureError.imageCreationFailed
        }
        
        return NSImage(cgImage: cropped, size: NSSize(width: rect.width, height: rect.height))
    }
    
    /// Check if screen capture permission is granted
    static func hasPermission() async -> Bool {
        do {
            _ = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            return true
        } catch {
            return false
        }
    }
    
    /// Request screen capture permission
    static func requestPermission() {
        // Opening System Preferences to the Screen Recording pane
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }
    
    // MARK: - Private Methods
    
    private func createFilter(for display: SCDisplay, content: SCShareableContent) async throws -> SCContentFilter {
        if config.excludeOwnWindows {
            // Get our app's windows
            let ourBundleID = Bundle.main.bundleIdentifier ?? ""
            let ourPID = ProcessInfo.processInfo.processIdentifier
            
            // Filter out our windows
            let excludedWindows = content.windows.filter { window in
                window.owningApplication?.processID == ourPID ||
                window.owningApplication?.bundleIdentifier == ourBundleID
            }
            
            // Create filter with display and excluding our windows
            return SCContentFilter(display: display, excludingWindows: excludedWindows)
        } else {
            return SCContentFilter(display: display, excludingWindows: [])
        }
    }
    
    private func captureSingleFrame(filter: SCContentFilter, config: SCStreamConfiguration) async throws -> NSImage {
        return try await withCheckedThrowingContinuation { continuation in
            Task {
                do {
                    // Use SCScreenshotManager for single frame capture
                    if #available(macOS 14.0, *) {
                        let cgImage = try await SCScreenshotManager.captureImage(
                            contentFilter: filter,
                            configuration: config
                        )
                        let image = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
                        continuation.resume(returning: image)
                    } else {
                        // Fallback for macOS 12.3-13.x using stream
                        let image = try await captureViaStream(filter: filter, config: config)
                        continuation.resume(returning: image)
                    }
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }
    
    @available(macOS 12.3, *)
    private func captureViaStream(filter: SCContentFilter, config: SCStreamConfiguration) async throws -> NSImage {
        // Create a one-shot stream for older macOS versions
        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        
        return try await withCheckedThrowingContinuation { continuation in
            class FrameHandler: NSObject, SCStreamOutput {
                var continuation: CheckedContinuation<NSImage, Error>?
                var hasResumed = false
                
                func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
                    guard !hasResumed, type == .screen else { return }
                    hasResumed = true
                    
                    guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
                        continuation?.resume(throwing: CaptureError.imageCreationFailed)
                        return
                    }
                    
                    let ciImage = CIImage(cvImageBuffer: imageBuffer)
                    let context = CIContext()
                    
                    guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else {
                        continuation?.resume(throwing: CaptureError.imageCreationFailed)
                        return
                    }
                    
                    let image = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
                    continuation?.resume(returning: image)
                    
                    // Stop the stream
                    Task {
                        try? await stream.stopCapture()
                    }
                }
            }
            
            let handler = FrameHandler()
            handler.continuation = continuation
            
            Task {
                do {
                    try stream.addStreamOutput(handler, type: .screen, sampleHandlerQueue: .main)
                    try await stream.startCapture()
                    
                    // Timeout after 5 seconds
                    try await Task.sleep(nanoseconds: 5_000_000_000)
                    if !handler.hasResumed {
                        handler.hasResumed = true
                        try await stream.stopCapture()
                        continuation.resume(throwing: CaptureError.captureNotPermitted)
                    }
                } catch {
                    if !handler.hasResumed {
                        handler.hasResumed = true
                        continuation.resume(throwing: error)
                    }
                }
            }
        }
    }
}

// MARK: - Convenience Extensions

@available(macOS 12.3, *)
extension ScreenCapture {
    /// Save captured image to file
    func captureScreenToFile(_ path: String) async throws {
        let image = try await captureScreen()
        try saveImage(image, to: path)
    }
    
    /// Save image to file
    private func saveImage(_ image: NSImage, to path: String) throws {
        guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw CaptureError.imageCreationFailed
        }
        
        let url = URL(fileURLWithPath: path)
        let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
        
        guard let destination = destination else {
            throw CaptureError.imageCreationFailed
        }
        
        CGImageDestinationAddImage(destination, cgImage, nil)
        CGImageDestinationFinalize(destination)
    }
    
    /// Get PNG data from image
    func pngData(from image: NSImage) -> Data? {
        guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return nil
        }
        
        let rep = NSBitmapImageRep(cgImage: cgImage)
        return rep.representation(using: .png, properties: [:])
    }
}

// MARK: - Fallback for older macOS versions

/// Fallback implementation using CGWindowListCreateImage for macOS < 12.3
class LegacyScreenCapture {
    
    enum CaptureError: Error {
        case captureFailure
    }
    
    /// Capture screen using Core Graphics (works on older macOS)
    func captureScreen(excludingWindowIDs: [CGWindowID] = []) throws -> NSImage {
        // Get all on-screen windows
        guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
            throw CaptureError.captureFailure
        }
        
        // Filter to get windows to include (excluding specified windows)
        let excludeSet = Set(excludingWindowIDs)
        var windowIDs: [CGWindowID] = []
        
        for window in windowList {
            if let windowID = window[kCGWindowNumber as String] as? CGWindowID {
                if !excludeSet.contains(windowID) {
                    windowIDs.append(windowID)
                }
            }
        }
        
        // Capture using CGWindowListCreateImage
        guard let cgImage = CGWindowListCreateImage(
            .null, // Capture entire screen
            .optionOnScreenOnly,
            kCGNullWindowID,
            [.boundsIgnoreFraming]
        ) else {
            throw CaptureError.captureFailure
        }
        
        return NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
    }
}
