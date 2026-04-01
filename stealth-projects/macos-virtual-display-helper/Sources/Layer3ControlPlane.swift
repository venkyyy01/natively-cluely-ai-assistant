import Foundation

public enum Layer3ControlPlaneOutcome: String, Codable, Equatable {
    case ok
    case degraded
    case blocked
}

public struct Layer3Blocker: Codable, Equatable {
    public let code: String
    public let message: String
    public let retryable: Bool

    public func asJsonObject() -> [String: Any] {
        [
            "code": code,
            "message": message,
            "retryable": retryable,
        ]
    }
}

public protocol Layer3Payload: Equatable {
    func asJsonObject() -> [String: Any]
}

public struct Layer3ResponseEnvelope<Payload: Layer3Payload>: Equatable {
    public let outcome: Layer3ControlPlaneOutcome
    public let failClosed: Bool
    public let presentationAllowed: Bool
    public let blockers: [Layer3Blocker]
    public let data: Payload

    public func asJsonObject() -> [String: Any] {
        [
            "outcome": outcome.rawValue,
            "failClosed": failClosed,
            "presentationAllowed": presentationAllowed,
            "blockers": blockers.map { $0.asJsonObject() },
            "data": data.asJsonObject(),
        ]
    }
}

public struct Layer3CreateProtectedSessionData: Layer3Payload {
    public let sessionId: String
    public let state: SessionState
    public let mode: String
    public let surfaceToken: String?
    public let reason: String?

    public func asJsonObject() -> [String: Any] {
        [
            "sessionId": sessionId,
            "state": state.rawValue,
            "mode": mode,
            "surfaceToken": surfaceToken ?? NSNull(),
            "reason": reason ?? NSNull(),
        ]
    }
}

public enum Layer3PresentationMode: String, Codable, Equatable {
    case nativeFullscreenPresenter = "native-fullscreen-presenter"
    case nativeOverlayCompositor = "native-overlay-compositor"
}

public enum Layer3DisplayPreference: String, Codable, Equatable {
    case activeDisplay = "active-display"
    case dedicatedDisplay = "dedicated-display"
}

public struct Layer3CreateProtectedSessionRequest: Codable, Equatable {
    public let sessionId: String
    public let presentationMode: Layer3PresentationMode
    public let displayPreference: Layer3DisplayPreference
    public let reason: String
}

public struct Layer3AttachSurfaceRequest: Codable, Equatable {
    public let sessionId: String
    public let surfaceSource: String
    public let surfaceId: String
    public let width: Int
    public let height: Int
    public let hiDpi: Bool
}

public struct Layer3PresentRequest: Codable, Equatable {
    public let sessionId: String
    public let activate: Bool
}

public struct Layer3TeardownData: Layer3Payload {
    public let released: Bool

    public func asJsonObject() -> [String: Any] {
        ["released": released]
    }
}

public struct Layer3HealthReport: Layer3Payload {
    public let sessionId: String
    public let state: SessionState
    public let surfaceAttached: Bool
    public let presenting: Bool
    public let recoveryPending: Bool
    public let blockers: [Layer3Blocker]
    public let lastTransitionAt: String

    public func asJsonObject() -> [String: Any] {
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

public struct Layer3TelemetryEvent: Codable, Equatable {
    public let sessionId: String
    public let type: String
    public let at: String
    public let detail: String

    public func asJsonObject() -> [String: Any] {
        [
            "sessionId": sessionId,
            "type": type,
            "at": at,
            "detail": detail,
        ]
    }
}

public struct Layer3TelemetryCounters: Codable, Equatable {
    public let capabilityProbeCount: Int
    public let blockedTransitionCount: Int
    public let recoveryCount: Int
    public let presentationStartCount: Int

    public func asJsonObject() -> [String: Any] {
        [
            "capabilityProbeCount": capabilityProbeCount,
            "blockedTransitionCount": blockedTransitionCount,
            "recoveryCount": recoveryCount,
            "presentationStartCount": presentationStartCount,
        ]
    }
}

public struct Layer3TelemetryReport: Layer3Payload {
    public let events: [Layer3TelemetryEvent]
    public let counters: Layer3TelemetryCounters

    public func asJsonObject() -> [String: Any] {
        [
            "events": events.map { $0.asJsonObject() },
            "counters": counters.asJsonObject(),
        ]
    }
}

extension Layer3CandidateReport: Layer3Payload {}
