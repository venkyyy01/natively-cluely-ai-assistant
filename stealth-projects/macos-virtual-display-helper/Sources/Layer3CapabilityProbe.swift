import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
#if canImport(Metal)
import Metal
#endif
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif

public enum Layer3CandidateStatus: String, Codable, Equatable {
    case proven
    case unproven
    case unsupported
}

public struct Layer3CandidateReport: Codable, Equatable {
    public let status: Layer3CandidateStatus
    public let candidateRenderer: String
    public let platform: String
    public let osVersion: String
    public let nativePresenterAvailable: Bool
    public let cgVirtualDisplayAvailable: Bool
    public let metalDeviceAvailable: Bool
    public let metalCommandQueueAvailable: Bool
    public let screenCaptureKitAvailable: Bool
    public let screenRecordingPermission: String
    public let candidatePhysicalDisplayMechanismProven: Bool
    public let blockers: [Layer3Blocker]
    public let reason: String?

    public init(
        status: Layer3CandidateStatus,
        candidateRenderer: String,
        platform: String = "darwin",
        osVersion: String,
        nativePresenterAvailable: Bool? = nil,
        cgVirtualDisplayAvailable: Bool,
        metalDeviceAvailable: Bool,
        metalCommandQueueAvailable: Bool,
        screenCaptureKitAvailable: Bool,
        screenRecordingPermission: String = "not-granted",
        candidatePhysicalDisplayMechanismProven: Bool? = nil,
        blockers: [Layer3Blocker] = [],
        reason: String?
    ) {
        self.status = status
        self.candidateRenderer = candidateRenderer
        self.platform = platform
        self.osVersion = osVersion
        self.nativePresenterAvailable = nativePresenterAvailable ?? (metalDeviceAvailable && metalCommandQueueAvailable)
        self.cgVirtualDisplayAvailable = cgVirtualDisplayAvailable
        self.metalDeviceAvailable = metalDeviceAvailable
        self.metalCommandQueueAvailable = metalCommandQueueAvailable
        self.screenCaptureKitAvailable = screenCaptureKitAvailable
        self.screenRecordingPermission = screenRecordingPermission
        self.candidatePhysicalDisplayMechanismProven = candidatePhysicalDisplayMechanismProven ?? (status == .proven)
        if blockers.isEmpty {
            switch status {
            case .proven:
                self.blockers = []
            case .unproven:
                self.blockers = [Layer3Blocker(code: "physical-display-mechanism-unproven", message: reason ?? "Physical display mechanism unproven", retryable: false)]
            case .unsupported:
                self.blockers = [Layer3Blocker(code: "unsupported-machine-state", message: reason ?? "Unsupported machine state", retryable: false)]
            }
        } else {
            self.blockers = blockers
        }
        self.reason = reason
    }

    public func asJsonObject() -> [String: Any] {
        [
            "status": status.rawValue,
            "candidateRenderer": candidateRenderer,
            "platform": platform,
            "osVersion": osVersion,
            "nativePresenterAvailable": nativePresenterAvailable,
            "cgVirtualDisplayAvailable": cgVirtualDisplayAvailable,
            "metalDeviceAvailable": metalDeviceAvailable,
            "metalCommandQueueAvailable": metalCommandQueueAvailable,
            "screenCaptureKitAvailable": screenCaptureKitAvailable,
            "screenRecordingPermission": screenRecordingPermission,
            "candidatePhysicalDisplayMechanismProven": candidatePhysicalDisplayMechanismProven,
            "blockers": blockers.map { $0.asJsonObject() },
            "reason": reason ?? NSNull(),
        ]
    }
}

public protocol Layer3CapabilityEnvironment {
    var osVersion: OperatingSystemVersion { get }
    var cgVirtualDisplayAvailable: Bool { get }
    var metalDeviceAvailable: Bool { get }
    var metalCommandQueueAvailable: Bool { get }
    var screenCaptureKitAvailable: Bool { get }
    var screenRecordingPermission: String { get }
}

public protocol Layer3CapabilityProbing {
    func probe() -> Layer3CandidateReport
}

public struct DefaultLayer3CapabilityEnvironment: Layer3CapabilityEnvironment {
    public let osVersion: OperatingSystemVersion

    public init(osVersion: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion) {
        self.osVersion = osVersion
    }

    public var cgVirtualDisplayAvailable: Bool {
        supportsLayer3ProgramOSFloor(osVersion) &&
        NSClassFromString("CGVirtualDisplayDescriptor") != nil &&
        NSClassFromString("CGVirtualDisplayMode") != nil &&
        NSClassFromString("CGVirtualDisplaySettings") != nil &&
        NSClassFromString("CGVirtualDisplay") != nil
    }

    public var metalDeviceAvailable: Bool {
#if canImport(Metal)
        MTLCreateSystemDefaultDevice() != nil
#else
        false
#endif
    }

    public var metalCommandQueueAvailable: Bool {
#if canImport(Metal)
        guard let device = MTLCreateSystemDefaultDevice() else {
            return false
        }
        return device.makeCommandQueue() != nil
#else
        false
#endif
    }

    public var screenCaptureKitAvailable: Bool {
#if canImport(ScreenCaptureKit)
        if #available(macOS 12.3, *) {
            return true
        }
        return false
#else
        false
#endif
    }

    public var screenRecordingPermission: String {
#if canImport(CoreGraphics)
        if #available(macOS 10.15, *) {
            return CGPreflightScreenCaptureAccess() ? "granted" : "not-granted"
        }
        return "not-required"
#else
        "not-granted"
#endif
    }
}

public struct DefaultLayer3CapabilityProbe: Layer3CapabilityProbing {
    private let environment: any Layer3CapabilityEnvironment

    public init(environment: any Layer3CapabilityEnvironment = DefaultLayer3CapabilityEnvironment()) {
        self.environment = environment
    }

    public func probe() -> Layer3CandidateReport {
        let candidateRenderer = "apple-native-metal-presenter"
        let osVersion = environment.osVersion
        let versionString = "\(osVersion.majorVersion).\(osVersion.minorVersion).\(osVersion.patchVersion)"

        if !supportsLayer3ProgramOSFloor(osVersion) {
            let blocker = Layer3Blocker(code: "unsupported-macos-version", message: "macOS 14+ required for Layer 3 validation program", retryable: false)
            return Layer3CandidateReport(
                status: .unsupported,
                candidateRenderer: candidateRenderer,
                osVersion: versionString,
                cgVirtualDisplayAvailable: environment.cgVirtualDisplayAvailable,
                metalDeviceAvailable: environment.metalDeviceAvailable,
                metalCommandQueueAvailable: environment.metalCommandQueueAvailable,
                screenCaptureKitAvailable: environment.screenCaptureKitAvailable,
                screenRecordingPermission: environment.screenRecordingPermission,
                blockers: [blocker],
                reason: blocker.message
            )
        }

        if !environment.cgVirtualDisplayAvailable {
            let blocker = Layer3Blocker(code: "cgvirtualdisplay-unavailable", message: "CGVirtualDisplay runtime unavailable", retryable: true)
            return Layer3CandidateReport(
                status: .unsupported,
                candidateRenderer: candidateRenderer,
                osVersion: versionString,
                cgVirtualDisplayAvailable: environment.cgVirtualDisplayAvailable,
                metalDeviceAvailable: environment.metalDeviceAvailable,
                metalCommandQueueAvailable: environment.metalCommandQueueAvailable,
                screenCaptureKitAvailable: environment.screenCaptureKitAvailable,
                screenRecordingPermission: environment.screenRecordingPermission,
                blockers: [blocker],
                reason: blocker.message
            )
        }

        if !environment.metalDeviceAvailable {
            let blocker = Layer3Blocker(code: "unsupported-machine-state", message: "Metal device unavailable", retryable: false)
            return Layer3CandidateReport(
                status: .unsupported,
                candidateRenderer: candidateRenderer,
                osVersion: versionString,
                cgVirtualDisplayAvailable: environment.cgVirtualDisplayAvailable,
                metalDeviceAvailable: environment.metalDeviceAvailable,
                metalCommandQueueAvailable: environment.metalCommandQueueAvailable,
                screenCaptureKitAvailable: environment.screenCaptureKitAvailable,
                screenRecordingPermission: environment.screenRecordingPermission,
                blockers: [blocker],
                reason: blocker.message
            )
        }

        if !environment.metalCommandQueueAvailable {
            let blocker = Layer3Blocker(code: "unsupported-machine-state", message: "Metal command queue unavailable", retryable: false)
            return Layer3CandidateReport(
                status: .unsupported,
                candidateRenderer: candidateRenderer,
                osVersion: versionString,
                cgVirtualDisplayAvailable: environment.cgVirtualDisplayAvailable,
                metalDeviceAvailable: environment.metalDeviceAvailable,
                metalCommandQueueAvailable: environment.metalCommandQueueAvailable,
                screenCaptureKitAvailable: environment.screenCaptureKitAvailable,
                screenRecordingPermission: environment.screenRecordingPermission,
                blockers: [blocker],
                reason: blocker.message
            )
        }

        if !environment.screenCaptureKitAvailable {
            let blocker = Layer3Blocker(code: "unsupported-machine-state", message: "ScreenCaptureKit unavailable", retryable: false)
            return Layer3CandidateReport(
                status: .unsupported,
                candidateRenderer: candidateRenderer,
                osVersion: versionString,
                cgVirtualDisplayAvailable: environment.cgVirtualDisplayAvailable,
                metalDeviceAvailable: environment.metalDeviceAvailable,
                metalCommandQueueAvailable: environment.metalCommandQueueAvailable,
                screenCaptureKitAvailable: environment.screenCaptureKitAvailable,
                screenRecordingPermission: environment.screenRecordingPermission,
                blockers: [blocker],
                reason: blocker.message
            )
        }

        var blockers: [Layer3Blocker] = []
        if environment.screenRecordingPermission != "granted" {
            blockers.append(Layer3Blocker(code: "screen-recording-permission-missing", message: "Screen Recording permission is not currently granted", retryable: true))
        }
        blockers.append(Layer3Blocker(code: "physical-display-mechanism-unproven", message: "Candidate Apple-native building blocks exist, but no proven macOS-supported hardware-protected presentation primitive has been validated yet", retryable: false))

        return Layer3CandidateReport(
            status: .unproven,
            candidateRenderer: candidateRenderer,
            osVersion: versionString,
            cgVirtualDisplayAvailable: environment.cgVirtualDisplayAvailable,
            metalDeviceAvailable: environment.metalDeviceAvailable,
            metalCommandQueueAvailable: environment.metalCommandQueueAvailable,
            screenCaptureKitAvailable: environment.screenCaptureKitAvailable,
            screenRecordingPermission: environment.screenRecordingPermission,
            blockers: blockers,
            reason: blockers.last?.message
        )
    }
}

private func supportsLayer3ProgramOSFloor(_ version: OperatingSystemVersion) -> Bool {
    version.majorVersion >= 14
}
