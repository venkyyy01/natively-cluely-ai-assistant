import Foundation

public enum FullStealthProtocolVersion: Int, Codable {
    case v1 = 1
}

public enum Command: String {
    case hello
    case createSession = "create-session"
    case releaseSession = "release-session"
    case status
    case serve
    case probeCapabilities = "probe-capabilities"
    case createProtectedSession = "create-protected-session"
    case attachSurface = "attach-surface"
    case present
    case heartbeat
    case teardownSession = "teardown-session"
    case getHealth = "get-health"
    case getTelemetry = "get-telemetry"
    case validateSession = "validate-session"
}

public typealias JsonObject = [String: Any]

public protocol JsonObjectConvertible {
    func asJsonObject() -> JsonObject
}

public enum HelperControlPlaneOutcome: String {
    case ok
    case degraded
    case blocked
}

public enum HelperSessionState: String {
    case creating
    case attached
    case presenting
    case blocked
    case failed
}

public struct HelperBlocker: JsonObjectConvertible, Equatable {
    public let code: String
    public let message: String
    public let retryable: Bool

    public func asJsonObject() -> JsonObject {
        [
            "code": code,
            "message": message,
            "retryable": retryable,
        ]
    }
}

public struct ControlPlaneEnvelope<Payload: JsonObjectConvertible>: JsonObjectConvertible {
    public let outcome: HelperControlPlaneOutcome
    public let failClosed: Bool
    public let presentationAllowed: Bool
    public let blockers: [HelperBlocker]
    public let data: Payload

    public func asJsonObject() -> JsonObject {
        [
            "outcome": outcome.rawValue,
            "failClosed": failClosed,
            "presentationAllowed": presentationAllowed,
            "blockers": blockers.map { $0.asJsonObject() },
            "data": data.asJsonObject(),
        ]
    }
}

public struct StatusResponse: JsonObjectConvertible {
    public let ready: Bool
    public let component: String
    public let notes: String?

    public func asJsonObject() -> JsonObject {
        [
            "ready": ready,
            "component": component,
            "notes": notes ?? NSNull(),
        ]
    }
}

public struct LegacySessionRequest: Codable {
    public let sessionId: String
    public let windowId: String
    public let width: Int
    public let height: Int
}

public struct SessionLookupRequest: Codable {
    public let sessionId: String
}

public struct CreateProtectedSessionRequest: Codable {
    public let sessionId: String
    public let presentationMode: String
    public let displayPreference: String
    public let reason: String
}

public struct AttachSurfaceRequest: Codable {
    public let sessionId: String
    public let surfaceSource: String
    public let surfaceId: String
    public let width: Int
    public let height: Int
    public let hiDpi: Bool
}

public struct PresentRequest: Codable {
    public let sessionId: String
    public let activate: Bool
}

public struct LegacySessionResponse: JsonObjectConvertible {
    public let ready: Bool
    public let sessionId: String
    public let mode: String
    public let surfaceToken: String?
    public let reason: String?

    public func asJsonObject() -> JsonObject {
        [
            "ready": ready,
            "sessionId": sessionId,
            "mode": mode,
            "surfaceToken": surfaceToken ?? NSNull(),
            "reason": reason ?? NSNull(),
        ]
    }
}

public struct ReleaseResponse: JsonObjectConvertible {
    public let released: Bool

    public func asJsonObject() -> JsonObject {
        ["released": released]
    }
}

public struct CapabilityReport: JsonObjectConvertible {
    public let status: String
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
    public let blockers: [HelperBlocker]
    public let reason: String?

    public func asJsonObject() -> JsonObject {
        [
            "status": status,
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

public struct CreateProtectedSessionData: JsonObjectConvertible {
    public let sessionId: String
    public let state: HelperSessionState

    public func asJsonObject() -> JsonObject {
        [
            "sessionId": sessionId,
            "state": state.rawValue,
        ]
    }
}

public struct HealthReport: JsonObjectConvertible {
    public let sessionId: String
    public let state: HelperSessionState
    public let surfaceAttached: Bool
    public let presenting: Bool
    public let recoveryPending: Bool
    public let blockers: [HelperBlocker]
    public let lastTransitionAt: String

    public func asJsonObject() -> JsonObject {
        [
            "sessionId": sessionId,
            "state": state.rawValue,
            "surfaceAttached": surfaceAttached,
            "presenting": presenting,
            "recoveryPending": recoveryPending,
            "blockers": blockers.map { $0.asJsonObject() },
            "lastTransitionAt": lastTransitionAt,
        ]
    }
}

public struct TelemetryEvent: JsonObjectConvertible {
    public let sessionId: String
    public let type: String
    public let at: String
    public let detail: String

    public func asJsonObject() -> JsonObject {
        [
            "sessionId": sessionId,
            "type": type,
            "at": at,
            "detail": detail,
        ]
    }
}

public struct TelemetryCounters: JsonObjectConvertible {
    public let capabilityProbeCount: Int
    public let blockedTransitionCount: Int
    public let presentationStartCount: Int

    public func asJsonObject() -> JsonObject {
        [
            "capabilityProbeCount": capabilityProbeCount,
            "blockedTransitionCount": blockedTransitionCount,
            "presentationStartCount": presentationStartCount,
        ]
    }
}

public struct TelemetryReport: JsonObjectConvertible {
    public let events: [TelemetryEvent]
    public let counters: TelemetryCounters

    public func asJsonObject() -> JsonObject {
        [
            "events": events.map { $0.asJsonObject() },
            "counters": counters.asJsonObject(),
        ]
    }
}

public struct ValidationReport: JsonObjectConvertible {
    public let sessionId: String
    public let status: String
    public let reason: String
    public let windowEnumerated: Bool
    public let matchedWindowNumber: Bool
    public let matchedWindowTitle: Bool
    public let screenCaptureKitEnumerated: Bool
    public let matchedShareableContentWindow: Bool

    public func asJsonObject() -> JsonObject {
        [
            "sessionId": sessionId,
            "status": status,
            "reason": reason,
            "windowEnumerated": windowEnumerated,
            "matchedWindowNumber": matchedWindowNumber,
            "matchedWindowTitle": matchedWindowTitle,
            "screenCaptureKitEnumerated": screenCaptureKitEnumerated,
            "matchedShareableContentWindow": matchedShareableContentWindow,
        ]
    }
}
