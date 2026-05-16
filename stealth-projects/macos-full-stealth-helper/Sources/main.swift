import Foundation

private enum StealthTime {
    private static let formatter: ISO8601DateFormatter = {
        ISO8601DateFormatter()
    }()

    static func timestamp() -> String {
        formatter.string(from: Date())
    }
}

private final class SessionRuntime {
    let sessionId: String
    var windowId: String?
    var width: Int
    var height: Int
    var hiDpi: Bool
    var reason: String?
    var state: HelperSessionState
    var surfaceId: String?
    var surfaceToken: String?
    var presenting: Bool
    var recoveryPending: Bool
    var blockers: [HelperBlocker]
    var lastTransitionAt: String
    var lastHeartbeatAt: Date
    var surface: StealthSurface?

    init(
        sessionId: String,
        windowId: String? = nil,
        width: Int,
        height: Int,
        hiDpi: Bool = false,
        reason: String? = nil,
        state: HelperSessionState,
        surfaceId: String? = nil,
        surfaceToken: String? = nil,
        presenting: Bool = false,
        recoveryPending: Bool = false,
        blockers: [HelperBlocker] = [],
        lastTransitionAt: String = SessionRuntime.timestamp(),
        lastHeartbeatAt: Date = Date()
    ) {
        self.sessionId = sessionId
        self.windowId = windowId
        self.width = width
        self.height = height
        self.hiDpi = hiDpi
        self.reason = reason
        self.state = state
        self.surfaceId = surfaceId
        self.surfaceToken = surfaceToken
        self.presenting = presenting
        self.recoveryPending = recoveryPending
        self.blockers = blockers
        self.lastTransitionAt = lastTransitionAt
        self.lastHeartbeatAt = lastHeartbeatAt
    }

    func healthReport() -> HealthReport {
        HealthReport(
            sessionId: sessionId,
            state: state,
            surfaceAttached: surface != nil,
            presenting: presenting,
            recoveryPending: recoveryPending,
            blockers: blockers,
            lastTransitionAt: lastTransitionAt
        )
    }

    func transition(to nextState: HelperSessionState, presenting nextPresenting: Bool? = nil, blockers nextBlockers: [HelperBlocker]? = nil) {
        state = nextState
        if let nextPresenting {
            presenting = nextPresenting
        }
        if let nextBlockers {
            blockers = nextBlockers
        }
        lastTransitionAt = SessionRuntime.timestamp()
    }

    func noteHeartbeat() {
        lastHeartbeatAt = Date()
    }

    private static func timestamp() -> String {
        StealthTime.timestamp()
    }
}

private struct HelperServerEvent {
    let event: String
    let sessionId: String
    let reason: String
    let failClosed: Bool

    func asJsonObject() -> JsonObject {
        [
            "event": event,
            "sessionId": sessionId,
            "reason": reason,
            "failClosed": failClosed,
        ]
    }
}

private struct HeartbeatMonitorState {
    let sessionId: String
    var lastHeartbeatAt: Date
    var presenting: Bool
    var blocked: Bool
}

private final class FullStealthHelperService {
    private let stateQueue = DispatchQueue(label: "macos-full-stealth-helper.state")
    private var sessions: [String: SessionRuntime] = [:]
    private var telemetryBySession: [String: [TelemetryEvent]] = [:]
    private var heartbeatMonitorStates: [String: HeartbeatMonitorState] = [:]
    private let heartbeatTimeoutMs: TimeInterval

    init(heartbeatTimeoutMs: TimeInterval = FullStealthHelperService.readMillisecondsEnv(
        key: "FULL_STEALTH_HEARTBEAT_TIMEOUT_MS",
        fallback: 2000
    )) {
        self.heartbeatTimeoutMs = heartbeatTimeoutMs
    }

    func status() -> StatusResponse {
        StatusResponse(
            ready: true,
            component: "macos-full-stealth-helper",
            notes: "scaffold control-plane with AppKit stealth surface"
        )
    }

    func createSession(_ request: LegacySessionRequest) -> LegacySessionResponse {
        stateQueue.sync {
            let runtime = SessionRuntime(
                sessionId: request.sessionId,
                windowId: request.windowId,
                width: request.width,
                height: request.height,
                state: .attached,
                surfaceToken: "surface-\(request.sessionId)"
            )
            sessions[request.sessionId] = runtime
            recordEvent(sessionId: request.sessionId, type: "session-created", detail: "legacy create-session")
            return LegacySessionResponse(
                ready: true,
                sessionId: request.sessionId,
                mode: "virtual-display",
                surfaceToken: runtime.surfaceToken,
                reason: nil
            )
        }
    }

    func releaseSession(sessionId: String) throws -> ReleaseResponse {
        try teardownRuntime(sessionId: sessionId)
        return ReleaseResponse(released: true)
    }

    func probeCapabilities() -> ControlPlaneEnvelope<CapabilityReport> {
        let report = CapabilityReport(
            status: "unproven",
            candidateRenderer: "appkit-metal-stealth-surface",
            platform: "darwin",
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            nativePresenterAvailable: true,
            cgVirtualDisplayAvailable: false,
            metalDeviceAvailable: true,
            metalCommandQueueAvailable: true,
            screenCaptureKitAvailable: false,
            screenRecordingPermission: "not-required",
            candidatePhysicalDisplayMechanismProven: false,
            blockers: [],
            reason: "NSH-002 scaffold uses an in-process AppKit surface while the dedicated presenter path is still being hardened"
        )
        return ControlPlaneEnvelope(
            outcome: .degraded,
            failClosed: false,
            presentationAllowed: true,
            blockers: [],
            data: report
        )
    }

    func createProtectedSession(_ request: CreateProtectedSessionRequest) -> ControlPlaneEnvelope<CreateProtectedSessionData> {
        stateQueue.sync {
            let runtime = SessionRuntime(
                sessionId: request.sessionId,
                width: 1280,
                height: 720,
                reason: request.reason,
                state: .creating,
                surfaceToken: "surface-\(request.sessionId)"
            )
            runtime.noteHeartbeat()
            sessions[request.sessionId] = runtime
            syncHeartbeatMonitorState(for: runtime)
            recordEvent(sessionId: request.sessionId, type: "session-created", detail: "protected session created")
            return ControlPlaneEnvelope(
                outcome: .ok,
                failClosed: false,
                presentationAllowed: true,
                blockers: [],
                data: CreateProtectedSessionData(sessionId: request.sessionId, state: .creating)
            )
        }
    }

    func attachSurface(_ request: AttachSurfaceRequest) -> ControlPlaneEnvelope<HealthReport> {
        guard request.width > 0, request.height > 0 else {
            let blocker = HelperBlocker(code: "invalid-surface-dimensions", message: "Surface dimensions must be positive", retryable: false)
            return ControlPlaneEnvelope(
                outcome: .blocked,
                failClosed: true,
                presentationAllowed: false,
                blockers: [blocker],
                data: HealthReport(
                    sessionId: request.sessionId,
                    state: .blocked,
                    surfaceAttached: false,
                    presenting: false,
                    recoveryPending: true,
                    blockers: [blocker],
                    lastTransitionAt: StealthTime.timestamp()
                )
            )
        }

        let previousSurface = stateQueue.sync { () -> StealthSurface? in
            let runtime = ensureRuntime(sessionId: request.sessionId, width: request.width, height: request.height)
            let previousSurface = runtime.surface
            runtime.surface = nil
            runtime.width = request.width
            runtime.height = request.height
            runtime.hiDpi = request.hiDpi
            runtime.surfaceId = request.surfaceId
            runtime.surfaceToken = request.surfaceId
            return previousSurface
        }
        try? previousSurface?.close()

        do {
            let surface = try StealthSurface(
                sessionId: request.sessionId,
                surfaceId: request.surfaceId,
                width: request.width,
                height: request.height,
                hiDpi: request.hiDpi,
                allowHeadlessFallback: stateQueue.sync { sessions[request.sessionId]?.reason == "validation-run" }
            )
            try surface.updateDrawableSize(width: request.width, height: request.height, hiDpi: request.hiDpi)

            guard try surface.usesHiddenWindowSharing() else {
                try? surface.close()
                return stateQueue.sync {
                    let blocker = HelperBlocker(code: "native-presenter-unavailable", message: "Stealth surface did not enter NSWindowSharingNone", retryable: false)
                    guard let runtime = sessions[request.sessionId] else {
                        return ControlPlaneEnvelope(
                            outcome: .blocked,
                            failClosed: true,
                            presentationAllowed: false,
                            blockers: [blocker],
                            data: HealthReport(
                                sessionId: request.sessionId,
                                state: .blocked,
                                surfaceAttached: false,
                                presenting: false,
                                recoveryPending: true,
                                blockers: [blocker],
                                lastTransitionAt: StealthTime.timestamp()
                            )
                        )
                    }
                    runtime.transition(to: .blocked, blockers: [blocker])
                    runtime.recoveryPending = true
                    syncHeartbeatMonitorState(for: runtime)
                    return ControlPlaneEnvelope(
                        outcome: .blocked,
                        failClosed: true,
                        presentationAllowed: false,
                        blockers: [blocker],
                        data: runtime.healthReport()
                    )
                }
            }

            return stateQueue.sync {
                guard let runtime = sessions[request.sessionId] else {
                    try? surface.close()
                    let blocker = HelperBlocker(code: "session-not-found", message: "Session is not active", retryable: true)
                    return ControlPlaneEnvelope(
                        outcome: .blocked,
                        failClosed: true,
                        presentationAllowed: false,
                        blockers: [blocker],
                        data: HealthReport(
                            sessionId: request.sessionId,
                            state: .failed,
                            surfaceAttached: false,
                            presenting: false,
                            recoveryPending: true,
                            blockers: [blocker],
                            lastTransitionAt: StealthTime.timestamp()
                        )
                    )
                }

                runtime.surface = surface
                runtime.noteHeartbeat()
                runtime.recoveryPending = false
                runtime.transition(to: .attached, presenting: false, blockers: [])
                syncHeartbeatMonitorState(for: runtime)
                recordEvent(sessionId: request.sessionId, type: "surface-attached", detail: request.surfaceId)
                return ControlPlaneEnvelope(
                    outcome: .ok,
                    failClosed: false,
                    presentationAllowed: true,
                    blockers: [],
                    data: runtime.healthReport()
                )
            }
        } catch {
            return stateQueue.sync {
                let blocker = HelperBlocker(code: "native-presenter-unavailable", message: error.localizedDescription, retryable: false)
                guard let runtime = sessions[request.sessionId] else {
                    return ControlPlaneEnvelope(
                        outcome: .blocked,
                        failClosed: true,
                        presentationAllowed: false,
                        blockers: [blocker],
                        data: HealthReport(
                            sessionId: request.sessionId,
                            state: .failed,
                            surfaceAttached: false,
                            presenting: false,
                            recoveryPending: true,
                            blockers: [blocker],
                            lastTransitionAt: StealthTime.timestamp()
                        )
                    )
                }
                runtime.transition(to: .blocked, blockers: [blocker])
                runtime.recoveryPending = true
                runtime.surface = nil
                syncHeartbeatMonitorState(for: runtime)
                return ControlPlaneEnvelope(
                    outcome: .blocked,
                    failClosed: true,
                    presentationAllowed: false,
                    blockers: [blocker],
                    data: runtime.healthReport()
                )
            }
        }
    }

    func present(_ request: PresentRequest) -> ControlPlaneEnvelope<HealthReport> {
        let preflight = stateQueue.sync { () -> (surface: StealthSurface?, response: ControlPlaneEnvelope<HealthReport>?) in
            let runtime = ensureRuntime(sessionId: request.sessionId, width: 1280, height: 720)

            guard let surface = runtime.surface else {
                let blocker = HelperBlocker(code: "surface-not-attached", message: "Attach a stealth surface before presenting", retryable: true)
                runtime.transition(to: .blocked, blockers: [blocker])
                runtime.recoveryPending = true
                return (nil, ControlPlaneEnvelope(
                    outcome: .blocked,
                    failClosed: true,
                    presentationAllowed: false,
                    blockers: [blocker],
                    data: runtime.healthReport()
                ))
            }

            return (surface, nil)
        }

        if let response = preflight.response {
            return response
        }

        guard let surface = preflight.surface else {
            let blocker = HelperBlocker(code: "surface-not-attached", message: "Attach a stealth surface before presenting", retryable: true)
            return ControlPlaneEnvelope(
                outcome: .blocked,
                failClosed: true,
                presentationAllowed: false,
                blockers: [blocker],
                data: HealthReport(
                    sessionId: request.sessionId,
                    state: .failed,
                    surfaceAttached: false,
                    presenting: false,
                    recoveryPending: true,
                    blockers: [blocker],
                    lastTransitionAt: StealthTime.timestamp()
                )
            )
        }

        do {
            if request.activate {
                try surface.show()
            } else {
                try surface.hide()
            }
            return stateQueue.sync {
                guard let runtime = sessions[request.sessionId] else {
                    let blocker = HelperBlocker(code: "session-not-found", message: "Session is not active", retryable: true)
                    return ControlPlaneEnvelope(
                        outcome: .blocked,
                        failClosed: true,
                        presentationAllowed: false,
                        blockers: [blocker],
                        data: HealthReport(
                            sessionId: request.sessionId,
                            state: .failed,
                            surfaceAttached: false,
                            presenting: false,
                            recoveryPending: true,
                            blockers: [blocker],
                            lastTransitionAt: StealthTime.timestamp()
                        )
                    )
                }

                if request.activate {
                    runtime.noteHeartbeat()
                    runtime.transition(to: .presenting, presenting: true, blockers: [])
                    recordEvent(sessionId: request.sessionId, type: "presentation-started", detail: "surface presented")
                } else {
                    runtime.transition(to: .attached, presenting: false, blockers: [])
                    recordEvent(sessionId: request.sessionId, type: "presentation-stopped", detail: "surface hidden")
                }

                runtime.recoveryPending = false
                syncHeartbeatMonitorState(for: runtime)
                return ControlPlaneEnvelope(
                    outcome: .ok,
                    failClosed: false,
                    presentationAllowed: request.activate,
                    blockers: [],
                    data: runtime.healthReport()
                )
            }
        } catch {
            return stateQueue.sync {
                let blocker = HelperBlocker(code: "native-presenter-unavailable", message: error.localizedDescription, retryable: false)
                guard let runtime = sessions[request.sessionId] else {
                    return ControlPlaneEnvelope(
                        outcome: .blocked,
                        failClosed: true,
                        presentationAllowed: false,
                        blockers: [blocker],
                        data: HealthReport(
                            sessionId: request.sessionId,
                            state: .failed,
                            surfaceAttached: false,
                            presenting: false,
                            recoveryPending: true,
                            blockers: [blocker],
                            lastTransitionAt: StealthTime.timestamp()
                        )
                    )
                }

                runtime.transition(to: .failed, presenting: false, blockers: [blocker])
                runtime.recoveryPending = true
                syncHeartbeatMonitorState(for: runtime)
                return ControlPlaneEnvelope(
                    outcome: .blocked,
                    failClosed: true,
                    presentationAllowed: false,
                    blockers: [blocker],
                    data: runtime.healthReport()
                )
            }
        }
    }

    func heartbeat(sessionId: String) -> ControlPlaneEnvelope<HealthReport> {
        let evaluated = stateQueue.sync { () -> (surfaceToHide: StealthSurface?, response: ControlPlaneEnvelope<HealthReport>) in
            guard let runtime = sessions[sessionId] else {
                let blocker = HelperBlocker(code: "session-not-found", message: "Session is not active", retryable: true)
                return (nil, ControlPlaneEnvelope(
                    outcome: .blocked,
                    failClosed: true,
                    presentationAllowed: false,
                    blockers: [blocker],
                    data: HealthReport(
                        sessionId: sessionId,
                        state: .failed,
                        surfaceAttached: false,
                        presenting: false,
                        recoveryPending: true,
                        blockers: [blocker],
                        lastTransitionAt: StealthTime.timestamp()
                    )
                ))
            }

            let surfaceToHide = markHeartbeatTimeoutIfNeeded(runtime)
            if runtime.blockers.isEmpty {
                runtime.noteHeartbeat()
            }
            syncHeartbeatMonitorState(for: runtime)

            return (surfaceToHide, ControlPlaneEnvelope(
                outcome: runtime.blockers.isEmpty ? .ok : .blocked,
                failClosed: !runtime.blockers.isEmpty,
                presentationAllowed: runtime.presenting,
                blockers: runtime.blockers,
                data: runtime.healthReport()
            ))
        }

        try? evaluated.surfaceToHide?.hide()
        return evaluated.response
    }

    func teardownProtectedSession(sessionId: String) throws -> ControlPlaneEnvelope<ReleaseResponse> {
        try teardownRuntime(sessionId: sessionId)
        return ControlPlaneEnvelope(
            outcome: .ok,
            failClosed: false,
            presentationAllowed: false,
            blockers: [],
            data: ReleaseResponse(released: true)
        )
    }

    func getHealth(sessionId: String) -> ControlPlaneEnvelope<HealthReport> {
        let evaluated = stateQueue.sync { () -> (surfaceToHide: StealthSurface?, response: ControlPlaneEnvelope<HealthReport>) in
            guard let runtime = sessions[sessionId] else {
                let blocker = HelperBlocker(code: "session-not-found", message: "Session is not active", retryable: true)
                return (nil, ControlPlaneEnvelope(
                    outcome: .blocked,
                    failClosed: true,
                    presentationAllowed: false,
                    blockers: [blocker],
                    data: HealthReport(
                        sessionId: sessionId,
                        state: .failed,
                        surfaceAttached: false,
                        presenting: false,
                        recoveryPending: true,
                        blockers: [blocker],
                        lastTransitionAt: StealthTime.timestamp()
                    )
                ))
            }

            let surfaceToHide = markHeartbeatTimeoutIfNeeded(runtime)
            syncHeartbeatMonitorState(for: runtime)

            return (surfaceToHide, ControlPlaneEnvelope(
                outcome: runtime.blockers.isEmpty ? .ok : .blocked,
                failClosed: !runtime.blockers.isEmpty,
                presentationAllowed: runtime.presenting,
                blockers: runtime.blockers,
                data: runtime.healthReport()
            ))
        }

        try? evaluated.surfaceToHide?.hide()
        return evaluated.response
    }

    func getTelemetry(sessionId: String) -> ControlPlaneEnvelope<TelemetryReport> {
        stateQueue.sync {
            let events = telemetryBySession[sessionId] ?? []
            let report = TelemetryReport(
                events: events,
                counters: TelemetryCounters(
                    capabilityProbeCount: events.filter { $0.type == "capability-probed" }.count,
                    blockedTransitionCount: events.filter { $0.type == "session-blocked" }.count,
                    presentationStartCount: events.filter { $0.type == "presentation-started" }.count
                )
            )

            return ControlPlaneEnvelope(
                outcome: .ok,
                failClosed: false,
                presentationAllowed: false,
                blockers: [],
                data: report
            )
        }
    }

    func validateSession(sessionId: String) -> ControlPlaneEnvelope<ValidationReport> {
        let validationPreflight = stateQueue.sync { () -> (surface: StealthSurface?, presenting: Bool, response: ControlPlaneEnvelope<ValidationReport>?) in
            guard let runtime = sessions[sessionId] else {
                let blocker = HelperBlocker(code: "session-not-found", message: "Session is not active", retryable: true)
                let report = ValidationReport(
                    sessionId: sessionId,
                    status: "failed",
                    reason: blocker.message,
                    windowEnumerated: false,
                    matchedWindowNumber: false,
                    matchedWindowTitle: false,
                    screenCaptureKitEnumerated: false,
                    matchedShareableContentWindow: false
                )
                return (nil, false, ControlPlaneEnvelope(
                    outcome: .blocked,
                    failClosed: false,
                    presentationAllowed: false,
                    blockers: [blocker],
                    data: report
                ))
            }

            guard runtime.presenting else {
                let blocker = HelperBlocker(code: "surface-not-attached", message: "Protected session is not currently presenting", retryable: true)
                let report = ValidationReport(
                    sessionId: sessionId,
                    status: "failed",
                    reason: blocker.message,
                    windowEnumerated: false,
                    matchedWindowNumber: false,
                    matchedWindowTitle: false,
                    screenCaptureKitEnumerated: false,
                    matchedShareableContentWindow: false
                )
                return (runtime.surface, runtime.presenting, ControlPlaneEnvelope(
                    outcome: .blocked,
                    failClosed: false,
                    presentationAllowed: false,
                    blockers: [blocker],
                    data: report
                ))
            }

            let surface = runtime.surface
            let presenting = runtime.presenting
            return (surface, presenting, nil)
        }

        if let response = validationPreflight.response {
            return response
        }

        let matchedWindowTitle: Bool
        let matchedWindowNumber: Bool
        if let surface = validationPreflight.surface {
            matchedWindowTitle = ((try? surface.title())?.isEmpty == false)
            matchedWindowNumber = ((try? surface.windowNumber()) ?? 0) != 0
        } else {
            matchedWindowTitle = false
            matchedWindowNumber = false
        }

        let report = ValidationReport(
            sessionId: sessionId,
            status: "inconclusive",
            reason: "NSH-002 scaffold validates control-plane wiring only; full capture exclusion validation remains pending",
            windowEnumerated: matchedWindowTitle || matchedWindowNumber,
            matchedWindowNumber: matchedWindowNumber,
            matchedWindowTitle: matchedWindowTitle,
            screenCaptureKitEnumerated: false,
            matchedShareableContentWindow: false
        )

        return ControlPlaneEnvelope(
            outcome: .ok,
            failClosed: false,
            presentationAllowed: validationPreflight.presenting,
            blockers: [],
            data: report
        )
    }

    func emitHeartbeatFaultEventsIfNeeded(_ emit: (JsonObject) throws -> Void) rethrows {
        let now = Date()
        var events: [JsonObject] = []
        stateQueue.sync {
            for sessionId in heartbeatMonitorStates.keys {
                guard var state = heartbeatMonitorStates[sessionId] else {
                    continue
                }

                let elapsedMs = now.timeIntervalSince(state.lastHeartbeatAt) * 1000
                guard state.presenting, !state.blocked, elapsedMs > heartbeatTimeoutMs else {
                    continue
                }

                state.blocked = true
                heartbeatMonitorStates[sessionId] = state
                events.append(
                    HelperServerEvent(
                        event: "helper-fault",
                        sessionId: state.sessionId,
                        reason: "stealth-heartbeat-missed",
                        failClosed: true
                    ).asJsonObject()
                )
            }
        }

        for event in events {
            try emit(event)
        }
    }

    private func ensureRuntime(sessionId: String, width: Int, height: Int) -> SessionRuntime {
        if let runtime = sessions[sessionId] {
            return runtime
        }

        let runtime = SessionRuntime(sessionId: sessionId, width: width, height: height, state: .creating)
        sessions[sessionId] = runtime
        syncHeartbeatMonitorState(for: runtime)
        return runtime
    }

    private func syncHeartbeatMonitorState(for runtime: SessionRuntime) {
        heartbeatMonitorStates[runtime.sessionId] = HeartbeatMonitorState(
            sessionId: runtime.sessionId,
            lastHeartbeatAt: runtime.lastHeartbeatAt,
            presenting: runtime.presenting,
            blocked: !runtime.blockers.isEmpty
        )
    }

    private func removeHeartbeatMonitorState(sessionId: String) {
        heartbeatMonitorStates.removeValue(forKey: sessionId)
    }

    private func markHeartbeatTimeoutIfNeeded(_ runtime: SessionRuntime) -> StealthSurface? {
        guard runtime.presenting, runtime.blockers.isEmpty else {
            return nil
        }

        let elapsedMs = Date().timeIntervalSince(runtime.lastHeartbeatAt) * 1000
        guard elapsedMs > heartbeatTimeoutMs else {
            return nil
        }

        let blocker = HelperBlocker(
            code: "stealth-heartbeat-missed",
            message: "Stealth heartbeat deadline exceeded",
            retryable: true
        )

        runtime.recoveryPending = true
        runtime.transition(to: .blocked, presenting: false, blockers: [blocker])
        syncHeartbeatMonitorState(for: runtime)
        recordEvent(sessionId: runtime.sessionId, type: "session-blocked", detail: blocker.code)
        return runtime.surface
    }

    private func teardownRuntime(sessionId: String) throws {
        let surface = stateQueue.sync { () -> StealthSurface? in
            guard let runtime = sessions.removeValue(forKey: sessionId) else {
                return nil
            }
            removeHeartbeatMonitorState(sessionId: sessionId)
            recordEvent(sessionId: sessionId, type: "presentation-stopped", detail: "session torn down")
            return runtime.surface
        }

        try surface?.close()
    }

    private func recordEvent(sessionId: String, type: String, detail: String) {
        let event = TelemetryEvent(
            sessionId: sessionId,
            type: type,
            at: StealthTime.timestamp(),
            detail: detail
        )
        telemetryBySession[sessionId, default: []].append(event)
    }

    private static func readMillisecondsEnv(key: String, fallback: TimeInterval) -> TimeInterval {
        guard let raw = ProcessInfo.processInfo.environment[key], let parsed = Double(raw), parsed > 0 else {
            return fallback
        }

        return parsed
    }
}

private let service = FullStealthHelperService()
private let args = CommandLine.arguments
private let stdoutLock = NSLock()

guard args.count >= 2, let command = Command(rawValue: args[1]) else {
    FileHandle.standardError.write(
        Data(
            "usage: macos-full-stealth-helper <create-session|release-session|status|serve|probe-capabilities|create-protected-session|attach-surface|present|teardown-session|get-health|get-telemetry|validate-session>\n".utf8
        )
    )
    exit(64)
}

do {
    switch command {
    case .hello:
        let data = try FileHandle.standardInput.readToEnd() ?? Data()
        let request = (try JSONSerialization.jsonObject(with: data)) as? JsonObject ?? [:]
        let capability = request["capability"] as? String
        try writeJson(["authenticated": capability != nil, "capability": capability ?? NSNull()])
    case .createSession:
        let request = try decodeStdin(LegacySessionRequest.self)
        try writeJson(service.createSession(request).asJsonObject())
    case .releaseSession:
        let request = try decodeStdin(SessionLookupRequest.self)
        try writeJson(try service.releaseSession(sessionId: request.sessionId).asJsonObject())
    case .status:
        try writeJson(service.status().asJsonObject())
    case .serve:
        try runServer(service: service)
    case .probeCapabilities:
        try writeJson(service.probeCapabilities().asJsonObject())
    case .createProtectedSession:
        let request = try decodeStdin(CreateProtectedSessionRequest.self)
        try writeJson(service.createProtectedSession(request).asJsonObject())
    case .attachSurface:
        let request = try decodeStdin(AttachSurfaceRequest.self)
        try writeJson(service.attachSurface(request).asJsonObject())
    case .present:
        let request = try decodeStdin(PresentRequest.self)
        try writeJson(service.present(request).asJsonObject())
    case .heartbeat:
        let request = try decodeStdin(SessionLookupRequest.self)
        try writeJson(service.heartbeat(sessionId: request.sessionId).asJsonObject())
    case .teardownSession:
        let request = try decodeStdin(SessionLookupRequest.self)
        try writeJson(try service.teardownProtectedSession(sessionId: request.sessionId).asJsonObject())
    case .getHealth:
        let request = try decodeStdin(SessionLookupRequest.self)
        try writeJson(service.getHealth(sessionId: request.sessionId).asJsonObject())
    case .getTelemetry:
        let request = try decodeStdin(SessionLookupRequest.self)
        try writeJson(service.getTelemetry(sessionId: request.sessionId).asJsonObject())
    case .validateSession:
        let request = try decodeStdin(SessionLookupRequest.self)
        try writeJson(service.validateSession(sessionId: request.sessionId).asJsonObject())
    }
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}

private func decodeStdin<T: Decodable>(_ type: T.Type) throws -> T {
    let data = try FileHandle.standardInput.readToEnd() ?? Data()
    return try JSONDecoder().decode(type, from: data)
}

@Sendable
private func decodeObject<T: Decodable>(_ type: T.Type, from object: JsonObject) throws -> T {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    return try JSONDecoder().decode(type, from: data)
}

@Sendable
private func writeJson(_ payload: JsonObject) throws {
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    stdoutLock.lock()
    defer { stdoutLock.unlock() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

private func runServer(service: FullStealthHelperService) throws {
    var serverCapability: String?
    let heartbeatMonitor = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInitiated))
    heartbeatMonitor.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
    heartbeatMonitor.setEventHandler {
        do {
            try service.emitHeartbeatFaultEventsIfNeeded { payload in
                var authenticatedPayload = payload
                if let capability = serverCapability {
                    authenticatedPayload["capability"] = capability
                }
                try writeJson(authenticatedPayload)
            }
        } catch {
            FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
        }
    }
    heartbeatMonitor.resume()
    defer { heartbeatMonitor.cancel() }

    while let line = readLine() {
        guard !line.isEmpty else {
            continue
        }

        handleServerRequestLine(line, service: service, serverCapability: &serverCapability)
    }
}

private func handleServerRequestLine(_ line: String, service: FullStealthHelperService, serverCapability: inout String?) {
    var requestId: String?
    do {
        guard let request = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? JsonObject else {
            try writeJson(["ok": false, "error": "Invalid request envelope"])
            return
        }

        requestId = request["id"] as? String
        guard let id = requestId,
              let commandName = request["command"] as? String,
              let command = Command(rawValue: commandName)
        else {
            try writeJson(["id": requestId ?? NSNull(), "ok": false, "error": "Invalid request envelope"])
            return
        }

        let requestNonce = request["nonce"] as? String
        let requestCapability = request["capability"] as? String
        if command == .hello {
            guard let capability = requestCapability, !capability.isEmpty else {
                try writeServerResponse(id: id, ok: false, result: nil, error: "Missing capability", nonce: requestNonce, capability: serverCapability)
                return
            }

            if let expected = serverCapability, expected != capability {
                try writeServerResponse(id: id, ok: false, result: nil, error: "Capability mismatch", nonce: requestNonce, capability: serverCapability)
                return
            }

            serverCapability = capability
            try writeServerResponse(
                id: id,
                ok: true,
                result: ["authenticated": true, "capability": capability],
                error: nil,
                nonce: requestNonce,
                capability: capability
            )
            return
        }

        if let expected = serverCapability, requestCapability != expected {
            try writeServerResponse(id: id, ok: false, result: nil, error: "Capability mismatch", nonce: requestNonce, capability: expected)
            return
        }

        let result: JsonObject
        switch command {
        case .hello:
            result = ["authenticated": true]
        case .createSession:
            result = service.createSession(try decodeObject(LegacySessionRequest.self, from: request)).asJsonObject()
        case .releaseSession:
            result = try service.releaseSession(sessionId: try decodeObject(SessionLookupRequest.self, from: request).sessionId).asJsonObject()
        case .status:
            result = service.status().asJsonObject()
        case .serve:
            result = ["ready": true]
        case .probeCapabilities:
            result = service.probeCapabilities().asJsonObject()
        case .createProtectedSession:
            result = service.createProtectedSession(try decodeObject(CreateProtectedSessionRequest.self, from: request)).asJsonObject()
        case .attachSurface:
            result = service.attachSurface(try decodeObject(AttachSurfaceRequest.self, from: request)).asJsonObject()
        case .present:
            result = service.present(try decodeObject(PresentRequest.self, from: request)).asJsonObject()
        case .heartbeat:
            result = service.heartbeat(sessionId: try decodeObject(SessionLookupRequest.self, from: request).sessionId).asJsonObject()
        case .teardownSession:
            result = try service.teardownProtectedSession(sessionId: try decodeObject(SessionLookupRequest.self, from: request).sessionId).asJsonObject()
        case .getHealth:
            result = service.getHealth(sessionId: try decodeObject(SessionLookupRequest.self, from: request).sessionId).asJsonObject()
        case .getTelemetry:
            result = service.getTelemetry(sessionId: try decodeObject(SessionLookupRequest.self, from: request).sessionId).asJsonObject()
        case .validateSession:
            result = service.validateSession(sessionId: try decodeObject(SessionLookupRequest.self, from: request).sessionId).asJsonObject()
        }

        try writeServerResponse(id: id, ok: true, result: result, error: nil, nonce: requestNonce, capability: serverCapability)
    } catch {
        do {
            try writeJson(["id": requestId ?? NSNull(), "ok": false, "error": error.localizedDescription])
        } catch {
            FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
        }
    }
}

private func writeServerResponse(
    id: String,
    ok: Bool,
    result: JsonObject?,
    error: String?,
    nonce: String?,
    capability: String?
) throws {
    var response: JsonObject = ["id": id, "ok": ok]
    if let result {
        response["result"] = result
    }
    if let error {
        response["error"] = error
    }
    if let nonce {
        response["nonce"] = nonce
    }
    if let capability {
        response["capability"] = capability
    }
    try writeJson(response)
}
