import Foundation

public struct SessionRequest: Codable, Equatable {
    public let sessionId: String
    public let windowId: String
    public let width: Int
    public let height: Int

    public init(sessionId: String, windowId: String, width: Int, height: Int) {
        self.sessionId = sessionId
        self.windowId = windowId
        self.width = width
        self.height = height
    }
}

public enum SessionState: String, Codable {
    case active
    case unsupported
}

public struct VirtualDisplaySession: Codable, Equatable {
    public let sessionId: String
    public let windowId: String
    public let width: Int
    public let height: Int
    public let state: SessionState
    public let displayName: String
    public let surfaceToken: String?
    public let reason: String?
}

public protocol SessionStore {
    func save(_ session: VirtualDisplaySession) throws
    func load(sessionId: String) throws -> VirtualDisplaySession?
    func remove(sessionId: String) throws
    func all() throws -> [VirtualDisplaySession]
}

public final class InMemorySessionStore: SessionStore {
    private var sessions: [String: VirtualDisplaySession] = [:]

    public init() {}

    public func save(_ session: VirtualDisplaySession) throws {
        sessions[session.sessionId] = session
    }

    public func load(sessionId: String) throws -> VirtualDisplaySession? {
        sessions[sessionId]
    }

    public func remove(sessionId: String) throws {
        sessions.removeValue(forKey: sessionId)
    }

    public func all() throws -> [VirtualDisplaySession] {
        Array(sessions.values)
    }
}

public final class FileSessionStore: SessionStore {
    private let fileURL: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public func save(_ session: VirtualDisplaySession) throws {
        var sessions = try loadAllSessions()
        sessions[session.sessionId] = session
        try persist(sessions)
    }

    public func load(sessionId: String) throws -> VirtualDisplaySession? {
        try loadAllSessions()[sessionId]
    }

    public func remove(sessionId: String) throws {
        var sessions = try loadAllSessions()
        sessions.removeValue(forKey: sessionId)
        try persist(sessions)
    }

    public func all() throws -> [VirtualDisplaySession] {
        Array(try loadAllSessions().values)
    }

    private func loadAllSessions() throws -> [String: VirtualDisplaySession] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return [:]
        }

        let data = try Data(contentsOf: fileURL)
        if data.isEmpty {
            return [:]
        }

        return try decoder.decode([String: VirtualDisplaySession].self, from: data)
    }

    private func persist(_ sessions: [String: VirtualDisplaySession]) throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try encoder.encode(sessions)
        try data.write(to: fileURL, options: .atomic)
    }
}

public struct BackendCreateResult {
    public let ready: Bool
    public let displayName: String
    public let surfaceToken: String?
    public let reason: String?

    public init(ready: Bool, displayName: String, surfaceToken: String?, reason: String?) {
        self.ready = ready
        self.displayName = displayName
        self.surfaceToken = surfaceToken
        self.reason = reason
    }
}

public struct CreateSessionResponse: Equatable {
    public let ready: Bool
    public let sessionId: String
    public let mode: String
    public let surfaceToken: String?
    public let reason: String?

    public func asJsonObject() -> [String: Any] {
        [
            "ready": ready,
            "sessionId": sessionId,
            "mode": mode,
            "surfaceToken": surfaceToken as Any,
            "reason": reason as Any,
        ]
    }
}

public struct ReleaseSessionResponse: Equatable {
    public let released: Bool

    public func asJsonObject() -> [String: Any] {
        ["released": released]
    }
}

public protocol VirtualDisplayBackend {
    func createSession(_ request: SessionRequest) throws -> BackendCreateResult
    func releaseSession(sessionId: String) throws
    func status() -> [String: Any]
}

public func makeDefaultVirtualDisplayBackend() -> VirtualDisplayBackend {
    CGVirtualDisplayBackend()
}

public struct UnsupportedVirtualDisplayBackend: VirtualDisplayBackend {
    public let reason: String

    public init(reason: String) {
        self.reason = reason
    }

    public func createSession(_ request: SessionRequest) throws -> BackendCreateResult {
        BackendCreateResult(
            ready: false,
            displayName: "InternalDisplay",
            surfaceToken: nil,
            reason: reason
        )
    }

    public func releaseSession(sessionId: String) throws {}

    public func status() -> [String: Any] {
        [
            "ready": false,
            "component": "macos-virtual-display-helper",
            "reason": reason,
            "backend": "unsupported"
        ]
    }
}

public final class VirtualDisplayService {
    private let backend: VirtualDisplayBackend
    private let sessionStore: SessionStore

    public init(backend: VirtualDisplayBackend, sessionStore: SessionStore) {
        self.backend = backend
        self.sessionStore = sessionStore
    }

    public func createSession(_ request: SessionRequest) throws -> CreateSessionResponse {
        let result = try backend.createSession(request)
        let session = VirtualDisplaySession(
            sessionId: request.sessionId,
            windowId: request.windowId,
            width: request.width,
            height: request.height,
            state: result.ready ? .active : .unsupported,
            displayName: result.displayName,
            surfaceToken: result.surfaceToken,
            reason: result.reason
        )
        try sessionStore.save(session)

        return CreateSessionResponse(
            ready: result.ready,
            sessionId: request.sessionId,
            mode: "virtual-display",
            surfaceToken: result.surfaceToken,
            reason: result.reason
        )
    }

    public func releaseSession(sessionId: String) throws -> ReleaseSessionResponse {
        try backend.releaseSession(sessionId: sessionId)
        try sessionStore.remove(sessionId: sessionId)
        return ReleaseSessionResponse(released: true)
    }

    public func status() throws -> [String: Any] {
        var payload = backend.status()
        payload["activeSessionCount"] = try sessionStore.all().count
        return payload
    }
}
