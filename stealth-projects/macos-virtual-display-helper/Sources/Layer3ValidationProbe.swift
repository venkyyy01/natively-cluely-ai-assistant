import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif

public struct Layer3PresenterValidationSnapshot: Equatable {
    public let sessionId: String
    public let windowTitle: String
    public let windowNumber: Int
    public let active: Bool
}

public enum Layer3ValidationStatus: String, Codable, Equatable {
    case failed
    case inconclusive
}

public struct Layer3ValidationReport: Layer3Payload {
    public let sessionId: String
    public let status: Layer3ValidationStatus
    public let reason: String
    public let windowEnumerated: Bool
    public let matchedWindowNumber: Bool
    public let matchedWindowTitle: Bool
    public let screenCaptureKitEnumerated: Bool
    public let matchedShareableContentWindow: Bool

    public func asJsonObject() -> [String: Any] {
        [
            "sessionId": sessionId,
            "status": status.rawValue,
            "reason": reason,
            "windowEnumerated": windowEnumerated,
            "matchedWindowNumber": matchedWindowNumber,
            "matchedWindowTitle": matchedWindowTitle,
            "screenCaptureKitEnumerated": screenCaptureKitEnumerated,
            "matchedShareableContentWindow": matchedShareableContentWindow,
        ]
    }
}

public protocol Layer3ValidationProbing {
    func validate(snapshot: Layer3PresenterValidationSnapshot) -> Layer3ValidationReport
}

struct Layer3WindowMetadata {
    let windowNumber: Int?
    let title: String?
}

protocol Layer3WindowMetadataProviding {
    func currentWindows() -> [Layer3WindowMetadata]
}

protocol Layer3ShareableContentProviding {
    func currentWindows() -> [Layer3WindowMetadata]
}

private struct DefaultLayer3WindowMetadataProvider: Layer3WindowMetadataProviding {
    func currentWindows() -> [Layer3WindowMetadata] {
        #if canImport(CoreGraphics)
        guard let infos = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else {
            return []
        }

        return infos.map { info in
            let number = info[kCGWindowNumber as String] as? Int
            let title = info[kCGWindowName as String] as? String
            return Layer3WindowMetadata(windowNumber: number, title: title)
        }
        #else
        []
        #endif
    }
}

private struct DefaultLayer3ShareableContentProvider: Layer3ShareableContentProviding {
    func currentWindows() -> [Layer3WindowMetadata] {
        #if canImport(ScreenCaptureKit)
        guard #available(macOS 12.3, *) else {
            return []
        }

        let semaphore = DispatchSemaphore(value: 0)
        var windows: [Layer3WindowMetadata] = []

        let task = Task { () -> [Layer3WindowMetadata] in
            do {
                let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                return shareable.windows.map { window in
                    Layer3WindowMetadata(windowNumber: Int(window.windowID), title: window.title)
                }
            } catch {
                return []
            }
        }

        Task {
            windows = await task.value
            semaphore.signal()
        }

        if semaphore.wait(timeout: .now() + 2) == .timedOut {
            task.cancel()
            return []
        }
        return windows
        #else
        return []
        #endif
    }
}

public struct DefaultLayer3ValidationProbe: Layer3ValidationProbing {
    private let provider: any Layer3WindowMetadataProviding
    private let shareableContentProvider: any Layer3ShareableContentProviding

    public init() {
        self.provider = DefaultLayer3WindowMetadataProvider()
        self.shareableContentProvider = DefaultLayer3ShareableContentProvider()
    }

    init(provider: any Layer3WindowMetadataProviding, shareableContentProvider: any Layer3ShareableContentProviding) {
        self.provider = provider
        self.shareableContentProvider = shareableContentProvider
    }

    public func validate(snapshot: Layer3PresenterValidationSnapshot) -> Layer3ValidationReport {
        let windows = provider.currentWindows()
        let matchedWindowNumber = windows.contains { $0.windowNumber == snapshot.windowNumber }
        let matchedWindowTitle = windows.contains { $0.title == snapshot.windowTitle }
        let windowEnumerated = matchedWindowNumber || matchedWindowTitle
        let shareableWindows = shareableContentProvider.currentWindows()
        let matchedShareableContentWindow = shareableWindows.contains { $0.windowNumber == snapshot.windowNumber || $0.title == snapshot.windowTitle }
        let screenCaptureKitEnumerated = matchedShareableContentWindow

        if windowEnumerated || screenCaptureKitEnumerated {
            return Layer3ValidationReport(
                sessionId: snapshot.sessionId,
                status: .failed,
                reason: screenCaptureKitEnumerated
                    ? "Presenter window is visible via ScreenCaptureKit shareable-content enumeration"
                    : "Presenter window is visible via CGWindowList enumeration",
                windowEnumerated: windowEnumerated,
                matchedWindowNumber: matchedWindowNumber,
                matchedWindowTitle: matchedWindowTitle,
                screenCaptureKitEnumerated: screenCaptureKitEnumerated,
                matchedShareableContentWindow: matchedShareableContentWindow
            )
        }

        return Layer3ValidationReport(
            sessionId: snapshot.sessionId,
            status: .inconclusive,
            reason: "Basic window enumeration did not reveal the presenter window, but hardware-protected presentation remains unproven",
            windowEnumerated: false,
            matchedWindowNumber: false,
            matchedWindowTitle: false,
            screenCaptureKitEnumerated: false,
            matchedShareableContentWindow: false
        )
    }
}
