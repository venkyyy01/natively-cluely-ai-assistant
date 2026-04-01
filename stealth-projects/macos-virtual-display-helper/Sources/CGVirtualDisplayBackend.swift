import Foundation
import CoreGraphics

public final class CGVirtualDisplayBackend: VirtualDisplayBackend {
    private final class ActiveDisplay {
        let descriptor: NSObject
        let settings: NSObject
        let display: NSObject

        init(descriptor: NSObject, settings: NSObject, display: NSObject) {
            self.descriptor = descriptor
            self.settings = settings
            self.display = display
        }
    }

    private var activeDisplays: [String: ActiveDisplay] = [:]

    public init() {}

    static func supportsOperatingSystemVersion(_ version: OperatingSystemVersion) -> Bool {
        version.majorVersion > 12 || (version.majorVersion == 12 && version.minorVersion >= 4)
    }

    public func createSession(_ request: SessionRequest) throws -> BackendCreateResult {
        guard Self.isSupported else {
            return BackendCreateResult(
                ready: false,
                displayName: "InternalDisplay",
                surfaceToken: nil,
                reason: Self.unsupportedReason
            )
        }

        let descriptor = try Self.makeDescriptor(for: request)
        let display = try Self.makeDisplay(descriptor: descriptor)
        let mode = try Self.makeMode(width: request.width, height: request.height, refreshRate: 60)
        let settings = try Self.makeSettings(mode: mode)
        let applied = try Self.applySettings(display: display, settings: settings)

        guard applied else {
            return BackendCreateResult(
                ready: false,
                displayName: descriptor.value(forKey: "name") as? String ?? "InternalDisplay",
                surfaceToken: nil,
                reason: "CGVirtualDisplay applySettings returned false"
            )
        }

        let displayID = (display.value(forKey: "displayID") as? NSNumber)?.uint32Value ?? 0
        activeDisplays[request.sessionId] = ActiveDisplay(descriptor: descriptor, settings: settings, display: display)

        return BackendCreateResult(
            ready: true,
            displayName: descriptor.value(forKey: "name") as? String ?? "InternalDisplay",
            surfaceToken: "display-\(displayID)",
            reason: nil
        )
    }

    public func releaseSession(sessionId: String) throws {
        activeDisplays.removeValue(forKey: sessionId)
    }

    public func status() -> [String: Any] {
        [
            "ready": Self.isSupported,
            "component": "macos-virtual-display-helper",
            "backend": Self.isSupported ? "cgvirtualdisplay" : "unsupported",
            "reason": Self.isSupported ? NSNull() : Self.unsupportedReason,
            "activeVirtualDisplays": activeDisplays.count
        ]
    }

    private static var unsupportedReason: String {
        unsupportedReason(for: ProcessInfo.processInfo.operatingSystemVersion)
    }

    private static func unsupportedReason(for version: OperatingSystemVersion) -> String {
        if !supportsOperatingSystemVersion(version) {
            return "CGVirtualDisplay requires macOS 12.4 or later"
        }
        return "CGVirtualDisplay classes are unavailable on this runtime"
    }

    private static var isSupported: Bool {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        guard supportsOperatingSystemVersion(version) else {
            return false
        }

        return NSClassFromString("CGVirtualDisplayDescriptor") != nil &&
        NSClassFromString("CGVirtualDisplayMode") != nil &&
        NSClassFromString("CGVirtualDisplaySettings") != nil &&
        NSClassFromString("CGVirtualDisplay") != nil
    }

    private static func makeDescriptor(for request: SessionRequest) throws -> NSObject {
        guard let descriptorClass = NSClassFromString("CGVirtualDisplayDescriptor") as? NSObject.Type else {
            throw NSError(domain: "CGVirtualDisplayBackend", code: 1, userInfo: [NSLocalizedDescriptionKey: unsupportedReason])
        }

        let descriptor = descriptorClass.init()
        descriptor.setValue("Natively Private Surface", forKey: "name")
        descriptor.setValue(NSNumber(value: 0x4E41), forKey: "vendorID")
        descriptor.setValue(NSNumber(value: 0x5456), forKey: "productID")
        descriptor.setValue(NSNumber(value: stableSerial(for: request)), forKey: "serialNum")
        descriptor.setValue(NSNumber(value: request.width), forKey: "maxPixelsWide")
        descriptor.setValue(NSNumber(value: request.height), forKey: "maxPixelsHigh")
        descriptor.setValue(NSValue(size: NSSize(width: 300, height: 200)), forKey: "sizeInMillimeters")
        descriptor.setValue(NSValue(point: NSPoint(x: 0.68, y: 0.32)), forKey: "redPrimary")
        descriptor.setValue(NSValue(point: NSPoint(x: 0.265, y: 0.69)), forKey: "greenPrimary")
        descriptor.setValue(NSValue(point: NSPoint(x: 0.15, y: 0.06)), forKey: "bluePrimary")
        descriptor.setValue(NSValue(point: NSPoint(x: 0.3127, y: 0.329)), forKey: "whitePoint")
        descriptor.setValue(DispatchQueue(label: "ai.natively.virtual-display.\(request.sessionId)"), forKey: "dispatchQueue")
        return descriptor
    }

    private static func makeDisplay(descriptor: NSObject) throws -> NSObject {
        guard let displayClass = NSClassFromString("CGVirtualDisplay") else {
            throw NSError(domain: "CGVirtualDisplayBackend", code: 2, userInfo: [NSLocalizedDescriptionKey: unsupportedReason])
        }

        let allocSelector = NSSelectorFromString("alloc")
        let initSelector = NSSelectorFromString("initWithDescriptor:")
        guard let allocated = (displayClass as AnyObject).perform(allocSelector)?.takeUnretainedValue() else {
            throw NSError(domain: "CGVirtualDisplayBackend", code: 3, userInfo: [NSLocalizedDescriptionKey: "Failed to allocate CGVirtualDisplay"]) 
        }

        typealias InitWithDescriptor = @convention(c) (AnyObject, Selector, AnyObject) -> Unmanaged<AnyObject>
        let method = (allocated as AnyObject).method(for: initSelector)
        let fn = unsafeBitCast(method, to: InitWithDescriptor.self)
        return fn(allocated, initSelector, descriptor).takeRetainedValue() as! NSObject
    }

    private static func makeMode(width: Int, height: Int, refreshRate: Double) throws -> NSObject {
        guard NSClassFromString("CGVirtualDisplayMode") != nil else {
            throw NSError(domain: "CGVirtualDisplayBackend", code: 4, userInfo: [NSLocalizedDescriptionKey: unsupportedReason])
        }

        let modeClass: AnyObject = NSClassFromString("CGVirtualDisplayMode")!
        let allocSelector = NSSelectorFromString("alloc")
        let initSelector = NSSelectorFromString("initWithWidth:height:refreshRate:")
        guard let allocated = modeClass.perform(allocSelector)?.takeUnretainedValue() else {
            throw NSError(domain: "CGVirtualDisplayBackend", code: 5, userInfo: [NSLocalizedDescriptionKey: "Failed to allocate CGVirtualDisplayMode"]) 
        }

        typealias InitWithMode = @convention(c) (AnyObject, Selector, UInt, UInt, Double) -> Unmanaged<AnyObject>
        let method = (allocated as AnyObject).method(for: initSelector)
        let fn = unsafeBitCast(method, to: InitWithMode.self)
        return fn(allocated, initSelector, UInt(width), UInt(height), refreshRate).takeRetainedValue() as! NSObject
    }

    private static func makeSettings(mode: NSObject) throws -> NSObject {
        guard let settingsClass = NSClassFromString("CGVirtualDisplaySettings") as? NSObject.Type else {
            throw NSError(domain: "CGVirtualDisplayBackend", code: 6, userInfo: [NSLocalizedDescriptionKey: unsupportedReason])
        }

        let settings = settingsClass.init()
        settings.setValue([mode], forKey: "modes")
        settings.setValue(NSNumber(value: true), forKey: "hiDPI")
        settings.setValue(NSNumber(value: 0), forKey: "rotation")
        return settings
    }

    private static func applySettings(display: NSObject, settings: NSObject) throws -> Bool {
        let selector = NSSelectorFromString("applySettings:")
        typealias ApplySettings = @convention(c) (AnyObject, Selector, AnyObject) -> Bool
        let method = display.method(for: selector)
        let fn = unsafeBitCast(method, to: ApplySettings.self)
        return fn(display, selector, settings)
    }

    static func stableSerial(for request: SessionRequest) -> UInt32 {
        var hash: UInt32 = 2166136261
        for byte in request.sessionId.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 16777619
        }

        return max(hash, 1)
    }
}
