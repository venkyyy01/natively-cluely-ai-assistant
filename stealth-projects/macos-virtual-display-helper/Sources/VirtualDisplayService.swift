import Foundation
import Darwin

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
    case creating
    case attached
    case presenting
    case blocked
    case failed
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
    public let surfaceId: String?
    public let hiDpi: Bool
    public let surfaceAttached: Bool
    public let presenting: Bool
    public let recoveryPending: Bool
    public let blockerCode: String?
    public let blockerRetryable: Bool
    public let lastTransitionAt: String

    public init(
        sessionId: String,
        windowId: String,
        width: Int,
        height: Int,
        state: SessionState,
        displayName: String,
        surfaceToken: String?,
        reason: String?,
        surfaceId: String? = nil,
        hiDpi: Bool = false,
        surfaceAttached: Bool = false,
        presenting: Bool = false,
        recoveryPending: Bool = false,
        blockerCode: String? = nil,
        blockerRetryable: Bool = false,
        lastTransitionAt: String = ISO8601DateFormatter().string(from: Date())
    ) {
        self.sessionId = sessionId
        self.windowId = windowId
        self.width = width
        self.height = height
        self.state = state
        self.displayName = displayName
        self.surfaceToken = surfaceToken
        self.reason = reason
        self.surfaceId = surfaceId
        self.hiDpi = hiDpi
        self.surfaceAttached = surfaceAttached
        self.presenting = presenting
        self.recoveryPending = recoveryPending
        self.blockerCode = blockerCode
        self.blockerRetryable = blockerRetryable
        self.lastTransitionAt = lastTransitionAt
    }

    private enum CodingKeys: String, CodingKey {
        case sessionId
        case windowId
        case width
        case height
        case state
        case displayName
        case surfaceToken
        case reason
        case surfaceId
        case hiDpi
        case surfaceAttached
        case presenting
        case recoveryPending
        case blockerCode
        case blockerRetryable
        case lastTransitionAt
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        windowId = try container.decode(String.self, forKey: .windowId)
        width = try container.decode(Int.self, forKey: .width)
        height = try container.decode(Int.self, forKey: .height)
        state = try container.decode(SessionState.self, forKey: .state)
        displayName = try container.decode(String.self, forKey: .displayName)
        surfaceToken = try container.decodeIfPresent(String.self, forKey: .surfaceToken)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        surfaceId = try container.decodeIfPresent(String.self, forKey: .surfaceId)
        hiDpi = try container.decodeIfPresent(Bool.self, forKey: .hiDpi) ?? false
        surfaceAttached = try container.decodeIfPresent(Bool.self, forKey: .surfaceAttached) ?? false
        presenting = try container.decodeIfPresent(Bool.self, forKey: .presenting) ?? false
        recoveryPending = try container.decodeIfPresent(Bool.self, forKey: .recoveryPending) ?? false
        blockerCode = try container.decodeIfPresent(String.self, forKey: .blockerCode)
        blockerRetryable = try container.decodeIfPresent(Bool.self, forKey: .blockerRetryable) ?? false
        lastTransitionAt = try container.decodeIfPresent(String.self, forKey: .lastTransitionAt) ?? ISO8601DateFormatter().string(from: Date())
    }
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
    private let lockURL: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(fileURL: URL) {
        self.fileURL = fileURL
        self.lockURL = fileURL.deletingPathExtension().appendingPathExtension("lock")
    }

    public func save(_ session: VirtualDisplaySession) throws {
        try withLock {
            var sessions = try loadAllSessionsUnlocked()
            sessions[session.sessionId] = session
            try persistUnlocked(sessions)
        }
    }

    public func load(sessionId: String) throws -> VirtualDisplaySession? {
        try withLock {
            try loadAllSessionsUnlocked()[sessionId]
        }
    }

    public func remove(sessionId: String) throws {
        try withLock {
            var sessions = try loadAllSessionsUnlocked()
            sessions.removeValue(forKey: sessionId)
            try persistUnlocked(sessions)
        }
    }

    public func all() throws -> [VirtualDisplaySession] {
        try withLock {
            Array(try loadAllSessionsUnlocked().values)
        }
    }

    private func loadAllSessionsUnlocked() throws -> [String: VirtualDisplaySession] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return [:]
        }

        let data = try Data(contentsOf: fileURL)
        if data.isEmpty {
            return [:]
        }

        return try decoder.decode([String: VirtualDisplaySession].self, from: data)
    }

    private func persistUnlocked(_ sessions: [String: VirtualDisplaySession]) throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try encoder.encode(sessions)
        try data.write(to: fileURL, options: .atomic)
    }

    private func withLock<T>(_ body: () throws -> T) throws -> T {
        let directory = lockURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let descriptor = open(lockURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else {
            throw NSError(domain: "FileSessionStore", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to open lock file"])
        }
        defer { close(descriptor) }

        guard flock(descriptor, LOCK_EX) == 0 else {
            throw NSError(domain: "FileSessionStore", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to acquire session store lock"])
        }
        defer { flock(descriptor, LOCK_UN) }

        return try body()
    }
}

public protocol Layer3TelemetryStore {
    func record(sessionId: String, type: String, detail: String, at: String) throws
    func report(sessionId: String) throws -> Layer3TelemetryReport
}

public final class InMemoryLayer3TelemetryStore: Layer3TelemetryStore {
    private var eventsBySession: [String: [Layer3TelemetryEvent]] = [:]

    public init() {}

    public func record(sessionId: String, type: String, detail: String, at: String) {
        let event = Layer3TelemetryEvent(sessionId: sessionId, type: type, at: at, detail: detail)
        eventsBySession[sessionId, default: []].append(event)
    }

    public func report(sessionId: String) -> Layer3TelemetryReport {
        let events = eventsBySession[sessionId] ?? []
        return Layer3TelemetryReport(
            events: events,
            counters: Layer3TelemetryCounters(
                capabilityProbeCount: events.filter { $0.type == "capability-probed" }.count,
                blockedTransitionCount: events.filter { $0.type == "session-blocked" }.count,
                recoveryCount: events.filter { $0.type == "session-recovered" }.count,
                presentationStartCount: events.filter { $0.type == "presentation-started" }.count
            )
        )
    }
}

public final class FileLayer3TelemetryStore: Layer3TelemetryStore {
    private let fileURL: URL
    private let lockURL: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(fileURL: URL) {
        self.fileURL = fileURL
        self.lockURL = fileURL.deletingPathExtension().appendingPathExtension("lock")
    }

    public func record(sessionId: String, type: String, detail: String, at: String) throws {
        try withLock {
            var allEvents = try loadUnlocked()
            let event = Layer3TelemetryEvent(sessionId: sessionId, type: type, at: at, detail: detail)
            allEvents[sessionId, default: []].append(event)
            try persistUnlocked(allEvents)
        }
    }

    public func report(sessionId: String) throws -> Layer3TelemetryReport {
        try withLock {
            let events = try loadUnlocked()[sessionId] ?? []
            return Layer3TelemetryReport(
                events: events,
                counters: Layer3TelemetryCounters(
                    capabilityProbeCount: events.filter { $0.type == "capability-probed" }.count,
                    blockedTransitionCount: events.filter { $0.type == "session-blocked" }.count,
                    recoveryCount: events.filter { $0.type == "session-recovered" }.count,
                    presentationStartCount: events.filter { $0.type == "presentation-started" }.count
                )
            )
        }
    }

    private func loadUnlocked() throws -> [String: [Layer3TelemetryEvent]] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return [:]
        }
        let data = try Data(contentsOf: fileURL)
        if data.isEmpty {
            return [:]
        }
        return try decoder.decode([String: [Layer3TelemetryEvent]].self, from: data)
    }

    private func persistUnlocked(_ events: [String: [Layer3TelemetryEvent]]) throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try encoder.encode(events)
        try data.write(to: fileURL, options: .atomic)
    }

    private func withLock<T>(_ body: () throws -> T) throws -> T {
        let directory = lockURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let descriptor = open(lockURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else {
            throw NSError(domain: "FileLayer3TelemetryStore", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to open lock file"])
        }
        defer { close(descriptor) }

        guard flock(descriptor, LOCK_EX) == 0 else {
            throw NSError(domain: "FileLayer3TelemetryStore", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to acquire telemetry store lock"])
        }
        defer { flock(descriptor, LOCK_UN) }

        return try body()
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
            "surfaceToken": surfaceToken ?? NSNull(),
            "reason": reason ?? NSNull(),
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
    private let layer3Probe: any Layer3CapabilityProbing
    private let presenterHost: any Layer3PresenterHosting
    private let validationProbe: any Layer3ValidationProbing
    private let telemetryStore: any Layer3TelemetryStore
    private let timestampProvider: () -> String

    public init(
        backend: VirtualDisplayBackend,
        sessionStore: SessionStore,
        layer3Probe: any Layer3CapabilityProbing = DefaultLayer3CapabilityProbe(),
        presenterHost: any Layer3PresenterHosting = makeDefaultLayer3PresenterHost(),
        validationProbe: any Layer3ValidationProbing = DefaultLayer3ValidationProbe(),
        telemetryStore: any Layer3TelemetryStore = InMemoryLayer3TelemetryStore(),
        timestampProvider: @escaping () -> String = { ISO8601DateFormatter().string(from: Date()) }
    ) {
        self.backend = backend
        self.sessionStore = sessionStore
        self.layer3Probe = layer3Probe
        self.presenterHost = presenterHost
        self.validationProbe = validationProbe
        self.telemetryStore = telemetryStore
        self.timestampProvider = timestampProvider
    }

    public func createSession(_ request: SessionRequest) throws -> CreateSessionResponse {
        guard request.width > 0, request.height > 0 else {
            return CreateSessionResponse(
                ready: false,
                sessionId: request.sessionId,
                mode: "virtual-display",
                surfaceToken: nil,
                reason: "Invalid surface dimensions"
            )
        }

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
        do {
            try sessionStore.save(session)
        } catch {
            if result.ready {
                try? backend.releaseSession(sessionId: request.sessionId)
            }
            throw error
        }

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
        payload["layer3Candidate"] = layer3Probe.probe().asJsonObject()
        return payload
    }

    public func probeCapabilities() -> Layer3ResponseEnvelope<Layer3CandidateReport> {
        let report = layer3Probe.probe()
        let blockers = blockers(for: report)
        let outcome: Layer3ControlPlaneOutcome = report.status == .proven ? .ok : .blocked
        return Layer3ResponseEnvelope(
            outcome: outcome,
            failClosed: false,
            presentationAllowed: report.status == .proven,
            blockers: blockers,
            data: report
        )
    }

    public func createProtectedSession(_ request: Layer3CreateProtectedSessionRequest) throws -> Layer3ResponseEnvelope<Layer3CreateProtectedSessionData> {
        try cleanupExistingProtectedSession(sessionId: request.sessionId)

        let capability = probeCapabilities()
        try telemetryStore.record(sessionId: request.sessionId, type: "capability-probed", detail: capability.data.reason ?? capability.data.status.rawValue, at: timestampProvider())
        if request.displayPreference != .dedicatedDisplay {
            let blocker = Layer3Blocker(code: "unsupported-machine-state", message: "Layer 3 helper requires dedicated-display mode", retryable: false)
            let blockedSession = VirtualDisplaySession(
                sessionId: request.sessionId,
                windowId: request.sessionId,
                width: 0,
                height: 0,
                state: .blocked,
                displayName: "InternalDisplay",
                surfaceToken: nil,
                reason: blocker.message,
                blockerCode: blocker.code,
                blockerRetryable: blocker.retryable,
                lastTransitionAt: timestampProvider()
            )
            try sessionStore.save(blockedSession)
            try telemetryStore.record(sessionId: request.sessionId, type: "session-blocked", detail: blocker.code, at: timestampProvider())
            return Layer3ResponseEnvelope(
                outcome: .blocked,
                failClosed: true,
                presentationAllowed: false,
                blockers: [blocker],
                data: Layer3CreateProtectedSessionData(
                    sessionId: request.sessionId,
                    state: .blocked,
                    mode: request.presentationMode.rawValue,
                    surfaceToken: nil,
                    reason: blocker.message
                )
            )
        }
        if request.presentationMode != .nativeFullscreenPresenter {
            let blocker = Layer3Blocker(code: "presentation-mode-unsupported", message: "Layer 3 helper currently supports only native-fullscreen-presenter mode", retryable: false)
            let blockedSession = VirtualDisplaySession(
                sessionId: request.sessionId,
                windowId: request.sessionId,
                width: 0,
                height: 0,
                state: .blocked,
                displayName: "InternalDisplay",
                surfaceToken: nil,
                reason: blocker.message,
                blockerCode: blocker.code,
                blockerRetryable: blocker.retryable,
                lastTransitionAt: timestampProvider()
            )
            try sessionStore.save(blockedSession)
            try telemetryStore.record(sessionId: request.sessionId, type: "session-blocked", detail: blocker.code, at: timestampProvider())
            return Layer3ResponseEnvelope(
                outcome: .blocked,
                failClosed: true,
                presentationAllowed: false,
                blockers: [blocker],
                data: Layer3CreateProtectedSessionData(
                    sessionId: request.sessionId,
                    state: .blocked,
                    mode: request.presentationMode.rawValue,
                    surfaceToken: nil,
                    reason: blocker.message
                )
            )
        }
        guard capability.outcome == .ok else {
            let blockedSession = VirtualDisplaySession(
                sessionId: request.sessionId,
                windowId: request.sessionId,
                width: 0,
                height: 0,
                state: .blocked,
                displayName: "InternalDisplay",
                surfaceToken: nil,
                reason: capability.blockers.first?.message,
                blockerCode: capability.blockers.first?.code,
                blockerRetryable: capability.blockers.first?.retryable ?? false,
                lastTransitionAt: timestampProvider()
            )
            try sessionStore.save(blockedSession)
            try telemetryStore.record(sessionId: request.sessionId, type: "session-blocked", detail: capability.blockers.first?.code ?? "blocked", at: timestampProvider())
            return Layer3ResponseEnvelope(
                outcome: .blocked,
                failClosed: true,
                presentationAllowed: false,
                blockers: capability.blockers,
                data: Layer3CreateProtectedSessionData(
                    sessionId: request.sessionId,
                    state: .blocked,
                    mode: request.presentationMode.rawValue,
                    surfaceToken: nil,
                    reason: capability.blockers.first?.message
                )
            )
        }

        let session = VirtualDisplaySession(
            sessionId: request.sessionId,
            windowId: request.sessionId,
            width: 0,
            height: 0,
            state: .creating,
            displayName: "InternalDisplay",
            surfaceToken: nil,
            reason: request.reason,
            lastTransitionAt: timestampProvider()
        )
        try sessionStore.save(session)
        try telemetryStore.record(sessionId: request.sessionId, type: "session-created", detail: request.presentationMode.rawValue, at: timestampProvider())

        return Layer3ResponseEnvelope(
            outcome: .ok,
            failClosed: true,
            presentationAllowed: true,
            blockers: [],
            data: Layer3CreateProtectedSessionData(
                sessionId: request.sessionId,
                state: .creating,
                mode: request.presentationMode.rawValue,
                surfaceToken: nil,
                reason: request.reason
            )
        )
    }

    public func attachSurface(_ request: Layer3AttachSurfaceRequest) throws -> Layer3ResponseEnvelope<Layer3HealthReport> {
        guard request.surfaceSource == "native-ui-host" else {
            return blockedHealthResponse(sessionId: request.sessionId, code: "native-presenter-unavailable", message: "Layer 3 helper only accepts native-ui-host surfaces")
        }
        guard request.width > 0, request.height > 0 else {
            return blockedHealthResponse(sessionId: request.sessionId, code: "invalid-surface-dimensions", message: "Layer 3 helper requires positive surface dimensions")
        }
        guard var session = try sessionStore.load(sessionId: request.sessionId) else {
            return blockedHealthResponse(sessionId: request.sessionId, code: "session-not-found", message: "Protected session not found")
        }
        guard session.state != .blocked else {
            return healthEnvelope(for: session, outcome: .blocked, presentationAllowed: false, blockers: blockers(for: session))
        }
        if session.surfaceAttached {
            return blockedHealthResponse(sessionId: request.sessionId, code: "surface-already-attached", message: "Protected session already has an attached surface")
        }

        if session.surfaceToken == nil {
            let backendResult = try backend.createSession(
                SessionRequest(
                    sessionId: session.sessionId,
                    windowId: session.windowId,
                    width: request.width,
                    height: request.height
                )
            )
            guard backendResult.ready else {
                let blockers = [Layer3Blocker(code: "cgvirtualdisplay-unavailable", message: backendResult.reason ?? "CGVirtualDisplay unavailable", retryable: true)]
                let blocked = VirtualDisplaySession(
                    sessionId: session.sessionId,
                    windowId: session.windowId,
                    width: request.width,
                    height: request.height,
                    state: .blocked,
                    displayName: backendResult.displayName,
                    surfaceToken: backendResult.surfaceToken,
                    reason: backendResult.reason,
                    surfaceId: nil,
                    hiDpi: request.hiDpi,
                    surfaceAttached: false,
                    presenting: false,
                    recoveryPending: false,
                    blockerCode: blockers[0].code,
                    blockerRetryable: blockers[0].retryable,
                    lastTransitionAt: timestampProvider()
                )
                do {
                    try sessionStore.save(blocked)
                } catch {
                    try? backend.releaseSession(sessionId: session.sessionId)
                    throw error
                }
                try telemetryStore.record(sessionId: request.sessionId, type: "session-blocked", detail: blockers[0].code, at: timestampProvider())
                return healthEnvelope(for: blocked, outcome: .blocked, presentationAllowed: false, blockers: blockers)
            }

            session = VirtualDisplaySession(
                sessionId: session.sessionId,
                windowId: session.windowId,
                width: request.width,
                height: request.height,
                state: session.state,
                displayName: backendResult.displayName,
                surfaceToken: backendResult.surfaceToken,
                reason: session.reason,
                surfaceId: session.surfaceId,
                hiDpi: request.hiDpi,
                surfaceAttached: session.surfaceAttached,
                presenting: session.presenting,
                recoveryPending: session.recoveryPending,
                lastTransitionAt: session.lastTransitionAt
            )
        }

        do {
            try presenterHost.attachSurface(sessionId: request.sessionId, surfaceId: request.surfaceId, displayToken: session.surfaceToken, width: request.width, height: request.height, hiDpi: request.hiDpi)
        } catch {
            if session.surfaceToken != nil {
                try? backend.releaseSession(sessionId: session.sessionId)
            }
            let blocked = VirtualDisplaySession(
                sessionId: session.sessionId,
                windowId: session.windowId,
                width: request.width,
                height: request.height,
                state: .blocked,
                displayName: session.displayName,
                surfaceToken: nil,
                reason: error.localizedDescription,
                surfaceId: nil,
                hiDpi: request.hiDpi,
                surfaceAttached: false,
                presenting: false,
                recoveryPending: false,
                blockerCode: "native-presenter-unavailable",
                blockerRetryable: false,
                lastTransitionAt: timestampProvider()
            )
            try sessionStore.save(blocked)
            try telemetryStore.record(sessionId: request.sessionId, type: "session-blocked", detail: "native-presenter-unavailable", at: timestampProvider())
            return healthEnvelope(for: blocked, outcome: .blocked, presentationAllowed: false, blockers: blockers(for: blocked))
        }

        session = VirtualDisplaySession(
            sessionId: session.sessionId,
            windowId: session.windowId,
            width: request.width,
            height: request.height,
            state: .attached,
            displayName: session.displayName,
            surfaceToken: session.surfaceToken,
            reason: session.reason,
            surfaceId: request.surfaceId,
            hiDpi: request.hiDpi,
            surfaceAttached: true,
            presenting: false,
            recoveryPending: false,
            lastTransitionAt: timestampProvider()
        )
        do {
            try sessionStore.save(session)
        } catch {
            if session.surfaceToken != nil {
                try? backend.releaseSession(sessionId: session.sessionId)
            }
            try? presenterHost.teardown(sessionId: session.sessionId)
            throw error
        }
        try telemetryStore.record(sessionId: request.sessionId, type: "surface-attached", detail: request.surfaceId, at: timestampProvider())
        return healthEnvelope(for: session, outcome: .ok, presentationAllowed: true, blockers: [])
    }

    public func present(_ request: Layer3PresentRequest) throws -> Layer3ResponseEnvelope<Layer3HealthReport> {
        guard var session = try sessionStore.load(sessionId: request.sessionId) else {
            return blockedHealthResponse(sessionId: request.sessionId, code: "session-not-found", message: "Protected session not found")
        }
        guard session.state != .blocked else {
            return healthEnvelope(for: session, outcome: .blocked, presentationAllowed: false, blockers: blockers(for: session))
        }
        guard session.surfaceAttached else {
            return blockedHealthResponse(sessionId: request.sessionId, code: "surface-not-attached", message: "Protected session has no attached surface")
        }

        do {
            try presenterHost.setPresentationActive(sessionId: request.sessionId, active: request.activate)
        } catch {
            let blocked = VirtualDisplaySession(
                sessionId: session.sessionId,
                windowId: session.windowId,
                width: session.width,
                height: session.height,
                state: .blocked,
                displayName: session.displayName,
                surfaceToken: session.surfaceToken,
                reason: error.localizedDescription,
                surfaceId: session.surfaceId,
                hiDpi: session.hiDpi,
                surfaceAttached: session.surfaceAttached,
                presenting: false,
                recoveryPending: false,
                blockerCode: "native-presenter-unavailable",
                blockerRetryable: false,
                lastTransitionAt: timestampProvider()
            )
            try sessionStore.save(blocked)
            try telemetryStore.record(sessionId: request.sessionId, type: "session-blocked", detail: "native-presenter-unavailable", at: timestampProvider())
            return healthEnvelope(for: blocked, outcome: .blocked, presentationAllowed: false, blockers: blockers(for: blocked))
        }

        let nextState: SessionState = request.activate ? .presenting : .attached
        session = VirtualDisplaySession(
            sessionId: session.sessionId,
            windowId: session.windowId,
            width: session.width,
            height: session.height,
            state: nextState,
            displayName: session.displayName,
            surfaceToken: session.surfaceToken,
            reason: session.reason,
            surfaceId: session.surfaceId,
            hiDpi: session.hiDpi,
            surfaceAttached: session.surfaceAttached,
            presenting: request.activate,
            recoveryPending: false,
            lastTransitionAt: timestampProvider()
        )
        try sessionStore.save(session)
        try telemetryStore.record(
            sessionId: request.sessionId,
            type: request.activate ? "presentation-started" : "presentation-stopped",
            detail: request.activate ? "active" : "inactive",
            at: timestampProvider()
        )
        return healthEnvelope(for: session, outcome: .ok, presentationAllowed: true, blockers: [])
    }

    public func health(sessionId: String) throws -> Layer3ResponseEnvelope<Layer3HealthReport> {
        guard let session = try sessionStore.load(sessionId: sessionId) else {
            return blockedHealthResponse(sessionId: sessionId, code: "session-not-found", message: "Protected session not found")
        }
        let blockers = blockers(for: session)
        let outcome: Layer3ControlPlaneOutcome = blockers.isEmpty ? .ok : .blocked
        return healthEnvelope(for: session, outcome: outcome, presentationAllowed: blockers.isEmpty && session.surfaceAttached, blockers: blockers)
    }

    public func telemetry(sessionId: String) throws -> Layer3ResponseEnvelope<Layer3TelemetryReport> {
        let report = try telemetryStore.report(sessionId: sessionId)
        return Layer3ResponseEnvelope(
            outcome: .ok,
            failClosed: false,
            presentationAllowed: false,
            blockers: [],
            data: report
        )
    }

    public func validateSession(sessionId: String) throws -> Layer3ResponseEnvelope<Layer3ValidationReport> {
        guard let session = try sessionStore.load(sessionId: sessionId) else {
            let blocker = Layer3Blocker(code: "session-not-found", message: "Protected session not found", retryable: false)
            return Layer3ResponseEnvelope(
                outcome: .blocked,
                failClosed: false,
                presentationAllowed: false,
                blockers: [blocker],
                data: Layer3ValidationReport(
                    sessionId: sessionId,
                    status: .failed,
                    reason: blocker.message,
                    windowEnumerated: false,
                    matchedWindowNumber: false,
                    matchedWindowTitle: false,
                    screenCaptureKitEnumerated: false,
                    matchedShareableContentWindow: false
                )
            )
        }
        guard session.presenting else {
            let blocker = Layer3Blocker(code: "surface-not-attached", message: "Protected session is not currently presenting", retryable: true)
            return Layer3ResponseEnvelope(
                outcome: .blocked,
                failClosed: false,
                presentationAllowed: false,
                blockers: [blocker],
                data: Layer3ValidationReport(
                    sessionId: sessionId,
                    status: .failed,
                    reason: blocker.message,
                    windowEnumerated: false,
                    matchedWindowNumber: false,
                    matchedWindowTitle: false,
                    screenCaptureKitEnumerated: false,
                    matchedShareableContentWindow: false
                )
            )
        }

        let snapshot: Layer3PresenterValidationSnapshot
        do {
            snapshot = try presenterHost.validationSnapshot(sessionId: sessionId)
        } catch {
            let blocker = Layer3Blocker(code: "native-presenter-unavailable", message: error.localizedDescription, retryable: true)
            return Layer3ResponseEnvelope(
                outcome: .blocked,
                failClosed: false,
                presentationAllowed: false,
                blockers: [blocker],
                data: Layer3ValidationReport(
                    sessionId: sessionId,
                    status: .failed,
                    reason: blocker.message,
                    windowEnumerated: false,
                    matchedWindowNumber: false,
                    matchedWindowTitle: false,
                    screenCaptureKitEnumerated: false,
                    matchedShareableContentWindow: false
                )
            )
        }
        let report = validationProbe.validate(snapshot: snapshot)
        try telemetryStore.record(sessionId: sessionId, type: "validation-run", detail: report.status.rawValue, at: timestampProvider())
        return Layer3ResponseEnvelope(
            outcome: .ok,
            failClosed: false,
            presentationAllowed: false,
            blockers: [],
            data: report
        )
    }

    public func teardownProtectedSession(sessionId: String) throws -> Layer3ResponseEnvelope<Layer3TeardownData> {
        do {
            try presenterHost.teardown(sessionId: sessionId)
        } catch {
            let blocker = Layer3Blocker(code: "native-presenter-unavailable", message: error.localizedDescription, retryable: true)
            return Layer3ResponseEnvelope(
                outcome: .degraded,
                failClosed: false,
                presentationAllowed: false,
                blockers: [blocker],
                data: Layer3TeardownData(released: false)
            )
        }

        do {
            try backend.releaseSession(sessionId: sessionId)
        } catch {
            let blocker = Layer3Blocker(code: "teardown-failed", message: error.localizedDescription, retryable: true)
            return Layer3ResponseEnvelope(
                outcome: .degraded,
                failClosed: false,
                presentationAllowed: false,
                blockers: [blocker],
                data: Layer3TeardownData(released: false)
            )
        }

        try sessionStore.remove(sessionId: sessionId)
        try telemetryStore.record(sessionId: sessionId, type: "presentation-stopped", detail: "teardown", at: timestampProvider())
        return Layer3ResponseEnvelope(
            outcome: .ok,
            failClosed: false,
            presentationAllowed: false,
            blockers: [],
            data: Layer3TeardownData(released: true)
        )
    }

    private func healthEnvelope(
        for session: VirtualDisplaySession,
        outcome: Layer3ControlPlaneOutcome,
        presentationAllowed: Bool,
        blockers: [Layer3Blocker]
    ) -> Layer3ResponseEnvelope<Layer3HealthReport> {
        Layer3ResponseEnvelope(
            outcome: outcome,
            failClosed: outcome != .ok,
            presentationAllowed: presentationAllowed,
            blockers: blockers,
            data: Layer3HealthReport(
                sessionId: session.sessionId,
                state: session.state,
                surfaceAttached: session.surfaceAttached,
                presenting: session.presenting,
                recoveryPending: session.recoveryPending,
                blockers: blockers,
                lastTransitionAt: session.lastTransitionAt
            )
        )
    }

    private func blockedHealthResponse(sessionId: String, code: String, message: String) -> Layer3ResponseEnvelope<Layer3HealthReport> {
        let blocker = Layer3Blocker(code: code, message: message, retryable: false)
        return Layer3ResponseEnvelope(
            outcome: .blocked,
            failClosed: true,
            presentationAllowed: false,
            blockers: [blocker],
            data: Layer3HealthReport(
                sessionId: sessionId,
                state: .blocked,
                surfaceAttached: false,
                presenting: false,
                recoveryPending: false,
                blockers: [blocker],
                lastTransitionAt: timestampProvider()
            )
        )
    }

    private func blockers(for report: Layer3CandidateReport) -> [Layer3Blocker] {
        report.blockers
    }

    private func blockers(for session: VirtualDisplaySession) -> [Layer3Blocker] {
        guard session.state == .blocked, let reason = session.reason else {
            return []
        }
        return [Layer3Blocker(code: session.blockerCode ?? "session-blocked", message: reason, retryable: session.blockerRetryable)]
    }

    private func cleanupExistingProtectedSession(sessionId: String) throws {
        guard let existing = try sessionStore.load(sessionId: sessionId) else {
            return
        }

        if existing.surfaceAttached || existing.surfaceId != nil {
            try presenterHost.teardown(sessionId: sessionId)
        }
        if existing.surfaceToken != nil {
            try backend.releaseSession(sessionId: sessionId)
        }
        try sessionStore.remove(sessionId: sessionId)
    }
}
