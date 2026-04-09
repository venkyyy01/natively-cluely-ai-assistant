import Foundation

public enum FullStealthProtocolVersion: Int, Codable {
    case v1 = 1
}

public struct FullStealthEnvelope<Params: Codable>: Codable {
    public let id: String
    public let version: FullStealthProtocolVersion
    public let method: String
    public let params: Params
}

public struct FullStealthResponse<Result: Codable>: Codable {
    public let id: String
    public let version: FullStealthProtocolVersion
    public let ok: Bool
    public let result: Result?
    public let error: String?
}

public struct ArmParams: Codable {
    public let sessionId: String
    public let presentationMode: String
    public let displayPreference: String
    public let reason: String
}

public struct HeartbeatParams: Codable {
    public let sessionId: String
}

public struct FrameRegion: Codable {
    public let x: Int
    public let y: Int
    public let width: Int
    public let height: Int
}

public struct SubmitFrameParams: Codable {
    public let sessionId: String
    public let surfaceId: String
    public let region: FrameRegion
}

public struct RelayInputParams: Codable {
    public let sessionId: String
    public let event: [String: String]
}

public struct FaultParams: Codable {
    public let sessionId: String
    public let reason: String
}

public struct StealthSessionState: Codable {
    public let sessionId: String
    public let state: String
    public let surfaceAttached: Bool
    public let presenting: Bool
    public let recoveryPending: Bool
}
