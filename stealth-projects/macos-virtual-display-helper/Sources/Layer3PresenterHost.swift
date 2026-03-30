import Foundation
#if canImport(AppKit)
import AppKit
#endif
#if canImport(QuartzCore)
import QuartzCore
#endif
#if canImport(Metal)
import Metal
#endif

public protocol Layer3PresenterHosting {
    func attachSurface(sessionId: String, surfaceId: String, displayToken: String?, width: Int, height: Int, hiDpi: Bool) throws
    func setPresentationActive(sessionId: String, active: Bool) throws
    func teardown(sessionId: String) throws
    func validationSnapshot(sessionId: String) throws -> Layer3PresenterValidationSnapshot
}

protocol Layer3PresenterWindow {
    func configureDrawableSize(width: Int, height: Int, hiDpi: Bool) throws
    func windowNumber() throws -> Int
    func title() throws -> String
    func show() throws
    func hide() throws
    func close() throws
}

protocol Layer3PresenterWindowFactory {
    func makeWindow(sessionId: String, surfaceId: String, displayToken: String?, width: Int, height: Int, hiDpi: Bool) throws -> Layer3PresenterWindow
}

public func makeDefaultLayer3PresenterHost() -> Layer3PresenterHosting {
    AppKitMetalPresenterHost()
}

public final class AppKitMetalPresenterHost: Layer3PresenterHosting {
    private struct CandidateSession {
        let surfaceId: String
        var active: Bool
        let window: Layer3PresenterWindow
        let windowTitle: String
        let windowNumber: Int
        let displayToken: String?
    }

    private let windowFactory: Layer3PresenterWindowFactory
    private var sessions: [String: CandidateSession] = [:]

    init(windowFactory: Layer3PresenterWindowFactory = AppKitLayer3PresenterWindowFactory()) {
        self.windowFactory = windowFactory
    }

    public func attachSurface(sessionId: String, surfaceId: String, displayToken: String?, width: Int, height: Int, hiDpi: Bool) throws {
        try ensurePresenterRuntimeReady()
        let details = try performOnMainThread {
            let window = try windowFactory.makeWindow(sessionId: sessionId, surfaceId: surfaceId, displayToken: displayToken, width: width, height: height, hiDpi: hiDpi)
            try window.configureDrawableSize(width: width, height: height, hiDpi: hiDpi)
            let title = try window.title()
            let windowNumber = try window.windowNumber()
            return (window, title, windowNumber)
        }
        sessions[sessionId] = CandidateSession(
            surfaceId: surfaceId,
            active: false,
            window: details.0,
            windowTitle: details.1,
            windowNumber: details.2,
            displayToken: displayToken
        )
    }

    public func setPresentationActive(sessionId: String, active: Bool) throws {
        guard var session = sessions[sessionId] else {
            throw NSError(domain: "Layer3PresenterHost", code: 1, userInfo: [NSLocalizedDescriptionKey: "Presenter session not found"])
        }

        try ensurePresenterRuntimeReady()
        try performOnMainThread {
            if active {
                try session.window.show()
            } else {
                try session.window.hide()
            }
        }
        session.active = active
        sessions[sessionId] = session
    }

    public func teardown(sessionId: String) throws {
        if let session = sessions.removeValue(forKey: sessionId) {
            try performOnMainThread {
                try session.window.close()
            }
        }
    }

    public func validationSnapshot(sessionId: String) throws -> Layer3PresenterValidationSnapshot {
        guard let session = sessions[sessionId] else {
            throw NSError(domain: "Layer3PresenterHost", code: 3, userInfo: [NSLocalizedDescriptionKey: "Presenter session not found"])
        }

        return try performOnMainThread {
            Layer3PresenterValidationSnapshot(
                sessionId: sessionId,
                windowTitle: session.windowTitle,
                windowNumber: session.windowNumber,
                active: session.active
            )
        }
    }

    private func ensurePresenterRuntimeReady() throws {
        try performOnMainThread {
            #if canImport(AppKit)
            _ = NSApplication.shared
            #endif

            #if canImport(Metal)
            guard MTLCreateSystemDefaultDevice() != nil else {
                throw NSError(domain: "Layer3PresenterHost", code: 2, userInfo: [NSLocalizedDescriptionKey: "Metal device unavailable for presenter host"])
            }
            #endif
        }
    }

    private func performOnMainThread<T>(_ work: () throws -> T) throws -> T {
        if Thread.isMainThread {
            return try work()
        }

        var result: Result<T, Error>?
        DispatchQueue.main.sync {
            result = Result { try work() }
        }
        return try result!.get()
    }

    #if canImport(QuartzCore) && canImport(Metal)
    private func makeMetalLayer(width: Int, height: Int, hiDpi: Bool) -> CAMetalLayer? {
        guard let device = MTLCreateSystemDefaultDevice() else {
            return nil
        }

        let layer = CAMetalLayer()
        layer.device = device
        layer.pixelFormat = .bgra8Unorm
        layer.framebufferOnly = false
        layer.drawableSize = CGSize(width: width, height: height)
        layer.contentsScale = hiDpi ? 2.0 : 1.0
        return layer
    }
    #endif
}

private final class AppKitLayer3PresenterWindowFactory: Layer3PresenterWindowFactory {
    init() {}

    func makeWindow(sessionId: String, surfaceId: String, displayToken: String?, width: Int, height: Int, hiDpi: Bool) throws -> Layer3PresenterWindow {
        try AppKitLayer3PresenterWindow(sessionId: sessionId, surfaceId: surfaceId, displayToken: displayToken, width: width, height: height, hiDpi: hiDpi)
    }
}

private final class AppKitLayer3PresenterWindow: Layer3PresenterWindow {
    private let window: NSWindow?
    private let metalLayer: CAMetalLayer?
    private let targetFrame: NSRect?

    init(sessionId: String, surfaceId: String, displayToken: String?, width: Int, height: Int, hiDpi: Bool) throws {
        #if canImport(AppKit) && canImport(QuartzCore) && canImport(Metal)
        let rect = NSRect(x: 0, y: 0, width: width, height: height)
        let styleMask: NSWindow.StyleMask = [.borderless]
        let window = NSWindow(contentRect: rect, styleMask: styleMask, backing: .buffered, defer: false)
        window.isOpaque = true
        window.backgroundColor = .black
        window.title = "Layer3Presenter-\(sessionId)-\(surfaceId)"
        window.level = .screenSaver
        window.collectionBehavior = [.fullScreenAuxiliary, .moveToActiveSpace, .stationary]
        let resolvedScreen = try AppKitLayer3PresenterWindow.resolveScreen(displayToken: displayToken)
        if let screen = resolvedScreen {
            window.setFrame(screen.frame, display: false)
        }

        let contentView = NSView(frame: rect)
        contentView.wantsLayer = true
        let metalLayer = CAMetalLayer()
        metalLayer.device = MTLCreateSystemDefaultDevice()
        metalLayer.pixelFormat = .bgra8Unorm
        metalLayer.framebufferOnly = false
        metalLayer.drawableSize = CGSize(width: width, height: height)
        metalLayer.contentsScale = hiDpi ? 2.0 : 1.0
        contentView.layer = metalLayer
        window.contentView = contentView

        self.window = window
        self.metalLayer = metalLayer
        self.targetFrame = resolvedScreen?.frame
        #else
        self.window = nil
        self.metalLayer = nil
        self.targetFrame = nil
        #endif
    }

    func configureDrawableSize(width: Int, height: Int, hiDpi: Bool) throws {
        #if canImport(AppKit)
        let frame: NSRect
        if let targetFrame {
            frame = targetFrame
        } else {
            let origin = window?.frame.origin ?? .zero
            frame = NSRect(origin: NSPoint(x: origin.x, y: origin.y), size: NSSize(width: width, height: height))
        }
        window?.setFrame(frame, display: false)
        window?.contentView?.frame = frame
        #endif
        #if canImport(QuartzCore)
        metalLayer?.drawableSize = CGSize(width: width, height: height)
        metalLayer?.contentsScale = hiDpi ? 2.0 : 1.0
        #endif
    }

    func windowNumber() throws -> Int {
        #if canImport(AppKit)
        return Int(window?.windowNumber ?? 0)
        #else
        return 0
        #endif
    }

    func title() throws -> String {
        #if canImport(AppKit)
        return window?.title ?? ""
        #else
        return ""
        #endif
    }

    func show() throws {
        #if canImport(AppKit)
        window?.orderFrontRegardless()
        #endif
    }

    func hide() throws {
        #if canImport(AppKit)
        window?.orderOut(nil)
        #endif
    }

    func close() throws {
        #if canImport(AppKit)
        window?.close()
        #endif
    }

    #if canImport(AppKit)
    private static func resolveScreen(displayToken: String?) throws -> NSScreen? {
        guard let token = displayToken else {
            return nil
        }
        guard let id = UInt32(token.replacingOccurrences(of: "display-", with: "")) else {
            throw NSError(domain: "Layer3PresenterHost", code: 4, userInfo: [NSLocalizedDescriptionKey: "Invalid display token"])
        }

        if let screen = NSScreen.screens.first(where: { screen in
            let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
            return number?.uint32Value == id
        }) {
            return screen
        }

        throw NSError(domain: "Layer3PresenterHost", code: 5, userInfo: [NSLocalizedDescriptionKey: "Target display screen not currently resolvable"])
    }
    #endif
}
