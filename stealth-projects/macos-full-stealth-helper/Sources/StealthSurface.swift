import Foundation
import Dispatch
#if canImport(AppKit)
import AppKit
#endif
#if canImport(QuartzCore)
import QuartzCore
#endif
#if canImport(Metal)
import Metal
#endif

public final class StealthSurface {
    #if canImport(AppKit) && canImport(QuartzCore) && canImport(Metal)
    private var window: NSWindow?
    private var metalLayer: CAMetalLayer?
    #endif

    public init(sessionId: String, surfaceId: String, width: Int, height: Int, hiDpi: Bool) throws {
        try runOnMainThread {
            #if canImport(AppKit) && canImport(QuartzCore) && canImport(Metal)
            _ = NSApplication.shared
            NSApplication.shared.setActivationPolicy(.accessory)

            let frame = NSRect(x: 0, y: 0, width: width, height: height)
            let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
            window.isOpaque = true
            window.backgroundColor = .black
            window.title = "FullStealth-\(sessionId)-\(surfaceId)"
            window.level = .screenSaver
            window.collectionBehavior = [.fullScreenAuxiliary, .moveToActiveSpace, .stationary]
            window.sharingType = .none
            window.ignoresMouseEvents = true

            let contentView = NSView(frame: frame)
            contentView.wantsLayer = true

            guard let device = MTLCreateSystemDefaultDevice() else {
                throw NSError(
                    domain: "StealthSurface",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Metal device unavailable for stealth surface"]
                )
            }

            let layer = CAMetalLayer()
            layer.device = device
            layer.pixelFormat = .bgra8Unorm
            layer.framebufferOnly = false
            layer.drawableSize = CGSize(width: width, height: height)
            layer.contentsScale = hiDpi ? 2.0 : 1.0
            contentView.layer = layer
            window.contentView = contentView
            window.orderOut(nil)

            self.window = window
            self.metalLayer = layer
            #else
            throw NSError(
                domain: "StealthSurface",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "AppKit/Metal stealth surface is unavailable on this platform"]
            )
            #endif
        }
    }

    public func updateDrawableSize(width: Int, height: Int, hiDpi: Bool) throws {
        try runOnMainThread {
            #if canImport(AppKit) && canImport(QuartzCore)
            let frame = NSRect(x: 0, y: 0, width: width, height: height)
            self.window?.setFrame(frame, display: false)
            self.window?.contentView?.frame = frame
            self.metalLayer?.drawableSize = CGSize(width: width, height: height)
            self.metalLayer?.contentsScale = hiDpi ? 2.0 : 1.0
            #endif
        }
    }

    public func show() throws {
        try runOnMainThread {
            #if canImport(AppKit)
            self.window?.orderFrontRegardless()
            #endif
        }
    }

    public func hide() throws {
        try runOnMainThread {
            #if canImport(AppKit)
            self.window?.orderOut(nil)
            #endif
        }
    }

    public func close() throws {
        try runOnMainThread {
            #if canImport(AppKit)
            self.window?.close()
            self.window = nil
            self.metalLayer = nil
            #endif
        }
    }

    public func usesHiddenWindowSharing() throws -> Bool {
        try runOnMainThread {
            #if canImport(AppKit)
            return self.window?.sharingType == NSWindow.SharingType.none
            #else
            return false
            #endif
        }
    }

    public func windowNumber() throws -> Int {
        try runOnMainThread {
            #if canImport(AppKit)
            return Int(self.window?.windowNumber ?? 0)
            #else
            return 0
            #endif
        }
    }

    public func title() throws -> String {
        try runOnMainThread {
            #if canImport(AppKit)
            return self.window?.title ?? ""
            #else
            return ""
            #endif
        }
    }

    private func runOnMainThread<T>(_ work: @escaping () throws -> T) throws -> T {
        if Thread.isMainThread {
            return try work()
        }

        var result: Result<T, Error>?
        DispatchQueue.main.sync {
            result = Result { try work() }
        }
        return try result!.get()
    }
}
