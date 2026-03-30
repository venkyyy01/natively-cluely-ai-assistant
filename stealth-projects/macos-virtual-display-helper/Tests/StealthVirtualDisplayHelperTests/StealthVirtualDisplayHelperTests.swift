import XCTest
@testable import StealthVirtualDisplayHelper

final class StealthVirtualDisplayHelperTests: XCTestCase {
    func testCGVirtualDisplayBackendVersionGateMatchesPlanMinimum() {
        XCTAssertTrue(CGVirtualDisplayBackend.supportsOperatingSystemVersion(.init(majorVersion: 12, minorVersion: 4, patchVersion: 0)))
        XCTAssertFalse(CGVirtualDisplayBackend.supportsOperatingSystemVersion(.init(majorVersion: 12, minorVersion: 3, patchVersion: 9)))
    }

    func testCGVirtualDisplayBackendStableSerialIsDeterministic() {
        let request = SessionRequest(sessionId: "stable-session", windowId: "window-1", width: 1280, height: 720)
        XCTAssertEqual(CGVirtualDisplayBackend.stableSerial(for: request), CGVirtualDisplayBackend.stableSerial(for: request))
    }

    func testInMemorySessionStorePersistsAndRemovesSessions() throws {
        let store = InMemorySessionStore()
        let session = VirtualDisplaySession(
            sessionId: "session-1",
            windowId: "window-1",
            width: 1280,
            height: 720,
            state: .active,
            displayName: "InternalDisplay",
            surfaceToken: "surface-1",
            reason: nil
        )

        try store.save(session)
        XCTAssertEqual(try store.load(sessionId: "session-1")?.surfaceToken, "surface-1")

        try store.remove(sessionId: "session-1")
        XCTAssertNil(try store.load(sessionId: "session-1"))
    }

    func testVirtualDisplayServiceReportsUnsupportedBackendReason() throws {
        let service = VirtualDisplayService(
            backend: UnsupportedVirtualDisplayBackend(reason: "not supported"),
            sessionStore: InMemorySessionStore()
        )

        let result = try service.createSession(.init(sessionId: "s", windowId: "w", width: 800, height: 600))
        XCTAssertFalse(result.ready)
        XCTAssertEqual(result.reason, "not supported")
    }

    func testFileSessionStorePersistsAcrossInstances() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let stateURL = directory.appendingPathComponent("sessions.json")

        let session = VirtualDisplaySession(
            sessionId: "persisted-session",
            windowId: "window-1",
            width: 1024,
            height: 768,
            state: .active,
            displayName: "InternalDisplay",
            surfaceToken: "surface-token",
            reason: nil
        )

        let writer = FileSessionStore(fileURL: stateURL)
        try writer.save(session)

        let reader = FileSessionStore(fileURL: stateURL)
        let loaded = try reader.load(sessionId: "persisted-session")
        XCTAssertEqual(loaded?.surfaceToken, "surface-token")
    }

    func testVirtualDisplayServiceStoresSuccessfulBackendSessions() throws {
        let service = VirtualDisplayService(
            backend: SuccessfulBackend(),
            sessionStore: InMemorySessionStore()
        )

        let response = try service.createSession(.init(sessionId: "ok", windowId: "window-2", width: 1920, height: 1080))
        XCTAssertTrue(response.ready)
        XCTAssertEqual(response.surfaceToken, "display-77")
        XCTAssertEqual(try service.status()["activeSessionCount"] as? Int, 1)
    }

    func testLayer3CapabilityProbeReturnsUnprovenWhenAppleNativeBuildingBlocksExist() {
        let probe = DefaultLayer3CapabilityProbe(
            environment: FakeLayer3Environment(
                osVersion: .init(majorVersion: 14, minorVersion: 4, patchVersion: 0),
                cgVirtualDisplayAvailable: true,
                metalDeviceAvailable: true,
                metalCommandQueueAvailable: true,
                screenCaptureKitAvailable: true,
                screenRecordingPermission: "granted"
            )
        )

        let report = probe.probe()

        XCTAssertEqual(report.status, .unproven)
        XCTAssertEqual(report.candidateRenderer, "apple-native-metal-presenter")
        XCTAssertEqual(report.screenRecordingPermission, "granted")
        XCTAssertEqual(report.reason, "Candidate Apple-native building blocks exist, but no proven macOS-supported hardware-protected presentation primitive has been validated yet")
    }

    func testLayer3CapabilityProbeReportsNotGrantedPermissionState() {
        let probe = DefaultLayer3CapabilityProbe(
            environment: FakeLayer3Environment(
                osVersion: .init(majorVersion: 14, minorVersion: 4, patchVersion: 0),
                cgVirtualDisplayAvailable: true,
                metalDeviceAvailable: true,
                metalCommandQueueAvailable: true,
                screenCaptureKitAvailable: true,
                screenRecordingPermission: "not-granted"
            )
        )

        let report = probe.probe()

        XCTAssertEqual(report.screenRecordingPermission, "not-granted")
        XCTAssertEqual(report.blockers.first?.code, "screen-recording-permission-missing")
    }

    func testLayer3CapabilityProbeReturnsUnsupportedWhenMetalIsUnavailable() {
        let probe = DefaultLayer3CapabilityProbe(
            environment: FakeLayer3Environment(
                osVersion: .init(majorVersion: 14, minorVersion: 4, patchVersion: 0),
                cgVirtualDisplayAvailable: true,
                metalDeviceAvailable: false,
                metalCommandQueueAvailable: false,
                screenCaptureKitAvailable: true,
                screenRecordingPermission: "granted"
            )
        )

        let report = probe.probe()

        XCTAssertEqual(report.status, .unsupported)
        XCTAssertEqual(report.reason, "Metal device unavailable")
    }

    func testVirtualDisplayServiceStatusIncludesLayer3CandidateReport() throws {
        let service = VirtualDisplayService(
            backend: SuccessfulBackend(),
            sessionStore: InMemorySessionStore(),
            layer3Probe: StubLayer3Probe(
                report: Layer3CandidateReport(
                    status: .unproven,
                    candidateRenderer: "apple-native-metal-presenter",
                    osVersion: "14.4.0",
                    cgVirtualDisplayAvailable: true,
                    metalDeviceAvailable: true,
                    metalCommandQueueAvailable: true,
                    screenCaptureKitAvailable: true,
                    reason: "unproven"
                )
            )
        )

        let status = try service.status()
        let layer3 = status["layer3Candidate"] as? [String: Any]

        XCTAssertEqual(layer3?["status"] as? String, "unproven")
        XCTAssertEqual(layer3?["candidateRenderer"] as? String, "apple-native-metal-presenter")
    }

    func testCreateProtectedSessionFailsClosedWhenLayer3MechanismIsUnproven() throws {
        let service = VirtualDisplayService(
            backend: SuccessfulBackend(),
            sessionStore: InMemorySessionStore(),
            layer3Probe: StubLayer3Probe(
                report: Layer3CandidateReport(
                    status: .unproven,
                    candidateRenderer: "apple-native-metal-presenter",
                    osVersion: "14.4.0",
                    cgVirtualDisplayAvailable: true,
                    metalDeviceAvailable: true,
                    metalCommandQueueAvailable: true,
                    screenCaptureKitAvailable: true,
                    reason: "unproven"
                )
            )
        )

        let response = try service.createProtectedSession(.init(sessionId: "p1", presentationMode: .nativeFullscreenPresenter, displayPreference: .dedicatedDisplay, reason: "validation-run"))

        XCTAssertEqual(response.outcome, .blocked)
        XCTAssertEqual(response.presentationAllowed, false)
        XCTAssertEqual(response.data.state, .blocked)
        XCTAssertEqual(response.blockers.first?.code, "physical-display-mechanism-unproven")

        let health = try service.health(sessionId: "p1")
        XCTAssertEqual(health.blockers.first?.code, "physical-display-mechanism-unproven")
    }

    func testCreateProtectedSessionBlocksNonDedicatedDisplayMode() throws {
        let service = VirtualDisplayService(
            backend: SuccessfulBackend(),
            sessionStore: InMemorySessionStore(),
            layer3Probe: StubLayer3Probe(
                report: Layer3CandidateReport(
                    status: .proven,
                    candidateRenderer: "apple-native-metal-presenter",
                    osVersion: "14.4.0",
                    cgVirtualDisplayAvailable: true,
                    metalDeviceAvailable: true,
                    metalCommandQueueAvailable: true,
                    screenCaptureKitAvailable: true,
                    reason: nil
                )
            )
        )

        let response = try service.createProtectedSession(.init(sessionId: "p1b", presentationMode: .nativeFullscreenPresenter, displayPreference: .activeDisplay, reason: "validation-run"))

        XCTAssertEqual(response.outcome, .blocked)
        XCTAssertEqual(response.blockers.first?.message, "Layer 3 helper requires dedicated-display mode")
    }

    func testCreateProtectedSessionBlocksUnsupportedPresentationMode() throws {
        let service = VirtualDisplayService(
            backend: SuccessfulBackend(),
            sessionStore: InMemorySessionStore(),
            layer3Probe: StubLayer3Probe(
                report: Layer3CandidateReport(
                    status: .proven,
                    candidateRenderer: "apple-native-metal-presenter",
                    osVersion: "14.4.0",
                    cgVirtualDisplayAvailable: true,
                    metalDeviceAvailable: true,
                    metalCommandQueueAvailable: true,
                    screenCaptureKitAvailable: true,
                    reason: nil
                )
            )
        )

        let response = try service.createProtectedSession(Layer3CreateProtectedSessionRequest(sessionId: "p1c", presentationMode: .nativeOverlayCompositor, displayPreference: .dedicatedDisplay, reason: "validation-run"))

        XCTAssertEqual(response.outcome, .blocked)
        XCTAssertEqual(response.blockers.first?.code, "presentation-mode-unsupported")
    }

    func testCreateAttachPresentAndTelemetryFlowWhenLayer3IsProven() throws {
        let host = RecordingPresenterHost()
        let service = VirtualDisplayService(
            backend: SuccessfulBackend(),
            sessionStore: InMemorySessionStore(),
            layer3Probe: StubLayer3Probe(
                report: Layer3CandidateReport(
                    status: .proven,
                    candidateRenderer: "apple-native-metal-presenter",
                    osVersion: "14.4.0",
                    cgVirtualDisplayAvailable: true,
                    metalDeviceAvailable: true,
                    metalCommandQueueAvailable: true,
                    screenCaptureKitAvailable: true,
                    reason: nil
                )
            ),
            presenterHost: host
        )

        let created = try service.createProtectedSession(Layer3CreateProtectedSessionRequest(sessionId: "p2", presentationMode: .nativeFullscreenPresenter, displayPreference: .dedicatedDisplay, reason: "validation-run"))
        XCTAssertEqual(created.outcome, .ok)
        XCTAssertEqual(created.data.state, .creating)

        let attached = try service.attachSurface(Layer3AttachSurfaceRequest(sessionId: "p2", surfaceSource: "native-ui-host", surfaceId: "surface-1", width: 1440, height: 900, hiDpi: true))
        XCTAssertEqual(attached.outcome, .ok)
        XCTAssertEqual(attached.data.state, .attached)
        XCTAssertEqual(attached.data.surfaceAttached, true)

        let presented = try service.present(Layer3PresentRequest(sessionId: "p2", activate: true))
        XCTAssertEqual(presented.outcome, .ok)
        XCTAssertEqual(presented.data.state, .presenting)
        XCTAssertEqual(presented.data.presenting, true)

        let health = try service.health(sessionId: "p2")
        XCTAssertEqual(health.outcome, .ok)
        XCTAssertEqual(health.data.state, .presenting)

        let telemetry = try service.telemetry(sessionId: "p2")
        XCTAssertEqual(telemetry.outcome, .ok)
        XCTAssertEqual(telemetry.data.counters.presentationStartCount, 1)
        XCTAssertEqual(telemetry.data.events.map(\.type), [
            "capability-probed",
            "session-created",
            "surface-attached",
            "presentation-started",
        ])
        XCTAssertEqual(host.attachedSurfaceIds, ["surface-1"])
        XCTAssertEqual(host.presentCalls, ["p2:true"])
    }

    func testAttachSurfaceRejectsNonNativeSurfaceSource() throws {
        let service = VirtualDisplayService(
            backend: SuccessfulBackend(),
            sessionStore: InMemorySessionStore(),
            layer3Probe: StubLayer3Probe(
                report: Layer3CandidateReport(
                    status: .proven,
                    candidateRenderer: "apple-native-metal-presenter",
                    osVersion: "14.4.0",
                    cgVirtualDisplayAvailable: true,
                    metalDeviceAvailable: true,
                    metalCommandQueueAvailable: true,
                    screenCaptureKitAvailable: true,
                    reason: nil
                )
            )
        )

        _ = try service.createProtectedSession(.init(sessionId: "p3", presentationMode: .nativeFullscreenPresenter, displayPreference: .dedicatedDisplay, reason: "validation-run"))
        let response = try service.attachSurface(.init(sessionId: "p3", surfaceSource: "electron-offscreen", surfaceId: "surface-2", width: 800, height: 600, hiDpi: false))

        XCTAssertEqual(response.outcome, .blocked)
        XCTAssertEqual(response.blockers.first?.message, "Layer 3 helper only accepts native-ui-host surfaces")
    }

    func testAttachSurfaceRejectsInvalidDimensions() throws {
        let service = VirtualDisplayService(
            backend: SuccessfulBackend(),
            sessionStore: InMemorySessionStore(),
            layer3Probe: StubLayer3Probe(
                report: Layer3CandidateReport(
                    status: .proven,
                    candidateRenderer: "apple-native-metal-presenter",
                    osVersion: "14.4.0",
                    cgVirtualDisplayAvailable: true,
                    metalDeviceAvailable: true,
                    metalCommandQueueAvailable: true,
                    screenCaptureKitAvailable: true,
                    reason: nil
                )
            )
        )

        _ = try service.createProtectedSession(.init(sessionId: "p4", presentationMode: .nativeFullscreenPresenter, displayPreference: .dedicatedDisplay, reason: "validation-run"))
        let response = try service.attachSurface(.init(sessionId: "p4", surfaceSource: "native-ui-host", surfaceId: "surface-3", width: 0, height: 600, hiDpi: false))

        XCTAssertEqual(response.outcome, .blocked)
        XCTAssertEqual(response.blockers.first?.code, "invalid-surface-dimensions")
    }

    func testAttachSurfacePersistsBlockedStateWhenPresenterHostFails() throws {
        let host = FailingPresenterHost(failOnAttach: true)
        let service = VirtualDisplayService(
            backend: SuccessfulBackend(),
            sessionStore: InMemorySessionStore(),
            layer3Probe: StubLayer3Probe(
                report: Layer3CandidateReport(
                    status: .proven,
                    candidateRenderer: "apple-native-metal-presenter",
                    osVersion: "14.4.0",
                    cgVirtualDisplayAvailable: true,
                    metalDeviceAvailable: true,
                    metalCommandQueueAvailable: true,
                    screenCaptureKitAvailable: true,
                    reason: nil
                )
            ),
            presenterHost: host
        )

        _ = try service.createProtectedSession(Layer3CreateProtectedSessionRequest(sessionId: "p6", presentationMode: .nativeFullscreenPresenter, displayPreference: .dedicatedDisplay, reason: "validation-run"))
        let response = try service.attachSurface(Layer3AttachSurfaceRequest(sessionId: "p6", surfaceSource: "native-ui-host", surfaceId: "surface-6", width: 1280, height: 720, hiDpi: true))
        let health = try service.health(sessionId: "p6")

        XCTAssertEqual(response.outcome, .blocked)
        XCTAssertEqual(health.outcome, .blocked)
        XCTAssertEqual(health.blockers.first?.code, "native-presenter-unavailable")

        let retriedPresent = try service.present(Layer3PresentRequest(sessionId: "p6", activate: true))
        XCTAssertEqual(retriedPresent.outcome, .blocked)

        _ = try service.createProtectedSession(Layer3CreateProtectedSessionRequest(sessionId: "p6", presentationMode: .nativeFullscreenPresenter, displayPreference: .dedicatedDisplay, reason: "validation-run"))
    }

    func testAttachSurfaceRejectsDuplicateAttachForSameSession() throws {
        let host = RecordingPresenterHost()
        let service = VirtualDisplayService(
            backend: SuccessfulBackend(),
            sessionStore: InMemorySessionStore(),
            layer3Probe: StubLayer3Probe(
                report: Layer3CandidateReport(
                    status: .proven,
                    candidateRenderer: "apple-native-metal-presenter",
                    osVersion: "14.4.0",
                    cgVirtualDisplayAvailable: true,
                    metalDeviceAvailable: true,
                    metalCommandQueueAvailable: true,
                    screenCaptureKitAvailable: true,
                    reason: nil
                )
            ),
            presenterHost: host
        )

        _ = try service.createProtectedSession(Layer3CreateProtectedSessionRequest(sessionId: "p7", presentationMode: .nativeFullscreenPresenter, displayPreference: .dedicatedDisplay, reason: "validation-run"))
        _ = try service.attachSurface(Layer3AttachSurfaceRequest(sessionId: "p7", surfaceSource: "native-ui-host", surfaceId: "surface-7", width: 1280, height: 720, hiDpi: true))
        let duplicate = try service.attachSurface(Layer3AttachSurfaceRequest(sessionId: "p7", surfaceSource: "native-ui-host", surfaceId: "surface-7b", width: 1280, height: 720, hiDpi: true))

        XCTAssertEqual(duplicate.outcome, .blocked)
        XCTAssertEqual(duplicate.blockers.first?.code, "surface-already-attached")
    }

    func testCreateProtectedSessionReusesSessionIdWithoutLeakingPresenterHostState() throws {
        let host = RecordingPresenterHost()
        let service = VirtualDisplayService(
            backend: SuccessfulBackend(),
            sessionStore: InMemorySessionStore(),
            layer3Probe: StubLayer3Probe(
                report: Layer3CandidateReport(
                    status: .proven,
                    candidateRenderer: "apple-native-metal-presenter",
                    osVersion: "14.4.0",
                    cgVirtualDisplayAvailable: true,
                    metalDeviceAvailable: true,
                    metalCommandQueueAvailable: true,
                    screenCaptureKitAvailable: true,
                    reason: nil
                )
            ),
            presenterHost: host
        )

        _ = try service.createProtectedSession(Layer3CreateProtectedSessionRequest(sessionId: "dup-session", presentationMode: .nativeFullscreenPresenter, displayPreference: .dedicatedDisplay, reason: "validation-run"))
        _ = try service.attachSurface(Layer3AttachSurfaceRequest(sessionId: "dup-session", surfaceSource: "native-ui-host", surfaceId: "surface-a", width: 800, height: 600, hiDpi: false))
        _ = try service.createProtectedSession(Layer3CreateProtectedSessionRequest(sessionId: "dup-session", presentationMode: .nativeFullscreenPresenter, displayPreference: .dedicatedDisplay, reason: "validation-run"))

        XCTAssertEqual(host.teardownCalls, ["dup-session"])
    }

    func testValidateSessionReportsFailureWhenPresenterWindowIsEnumerable() throws {
        let validationProbe = StubLayer3ValidationProbe(
            report: Layer3ValidationReport(
                sessionId: "v1",
                status: .failed,
                reason: "Presenter window is visible via CGWindowList enumeration",
                windowEnumerated: true,
                matchedWindowNumber: true,
                matchedWindowTitle: true,
                screenCaptureKitEnumerated: false,
                matchedShareableContentWindow: false
            )
        )
        let service = VirtualDisplayService(
            backend: SuccessfulBackend(),
            sessionStore: InMemorySessionStore(),
            layer3Probe: StubLayer3Probe(
                report: Layer3CandidateReport(
                    status: .proven,
                    candidateRenderer: "apple-native-metal-presenter",
                    osVersion: "14.4.0",
                    cgVirtualDisplayAvailable: true,
                    metalDeviceAvailable: true,
                    metalCommandQueueAvailable: true,
                    screenCaptureKitAvailable: true,
                    screenRecordingPermission: "granted",
                    reason: nil
                )
            ),
            presenterHost: ValidationSnapshotPresenterHost(snapshot: .init(sessionId: "v1", windowTitle: "Layer3Presenter-v1", windowNumber: 77, active: true)),
            validationProbe: validationProbe
        )

        _ = try service.createProtectedSession(Layer3CreateProtectedSessionRequest(sessionId: "v1", presentationMode: .nativeFullscreenPresenter, displayPreference: .dedicatedDisplay, reason: "validation-run"))
        _ = try service.attachSurface(Layer3AttachSurfaceRequest(sessionId: "v1", surfaceSource: "native-ui-host", surfaceId: "surface-v1", width: 1280, height: 720, hiDpi: true))
        _ = try service.present(Layer3PresentRequest(sessionId: "v1", activate: true))

        let result = try service.validateSession(sessionId: "v1")

        XCTAssertEqual(result.outcome, .ok)
        XCTAssertEqual(result.data.status, .failed)
        XCTAssertEqual(result.data.windowEnumerated, true)
        XCTAssertEqual(result.data.screenCaptureKitEnumerated, false)
    }

    func testLayer3ValidationProbeReportsFailureWhenScreenCaptureKitEnumeratesWindow() {
        let probe = DefaultLayer3ValidationProbe(
            provider: StubWindowMetadataProvider(windows: []),
            shareableContentProvider: StubShareableContentProvider(
                windows: [Layer3WindowMetadata(windowNumber: 91, title: "Layer3Presenter-sckt")]
            )
        )

        let report = probe.validate(
            snapshot: .init(sessionId: "sckt-1", windowTitle: "Layer3Presenter-sckt", windowNumber: 91, active: true)
        )

        XCTAssertEqual(report.status, .failed)
        XCTAssertEqual(report.screenCaptureKitEnumerated, true)
        XCTAssertEqual(report.matchedShareableContentWindow, true)
    }

    func testValidateSessionBlocksWhenPresenterSnapshotIsUnavailable() throws {
        let service = VirtualDisplayService(
            backend: SuccessfulBackend(),
            sessionStore: InMemorySessionStore(),
            layer3Probe: StubLayer3Probe(
                report: Layer3CandidateReport(
                    status: .proven,
                    candidateRenderer: "apple-native-metal-presenter",
                    osVersion: "14.4.0",
                    cgVirtualDisplayAvailable: true,
                    metalDeviceAvailable: true,
                    metalCommandQueueAvailable: true,
                    screenCaptureKitAvailable: true,
                    screenRecordingPermission: "granted",
                    reason: nil
                )
            ),
            presenterHost: RecordingPresenterHost()
        )

        let result = try service.validateSession(sessionId: "missing")

        XCTAssertEqual(result.outcome, .blocked)
        XCTAssertEqual(result.blockers.first?.code, "session-not-found")
    }

    func testValidateSessionReturnsStructuredBlockedResponseWhenSnapshotLookupFails() throws {
        let service = VirtualDisplayService(
            backend: SuccessfulBackend(),
            sessionStore: InMemorySessionStore(),
            layer3Probe: StubLayer3Probe(
                report: Layer3CandidateReport(
                    status: .proven,
                    candidateRenderer: "apple-native-metal-presenter",
                    osVersion: "14.4.0",
                    cgVirtualDisplayAvailable: true,
                    metalDeviceAvailable: true,
                    metalCommandQueueAvailable: true,
                    screenCaptureKitAvailable: true,
                    screenRecordingPermission: "granted",
                    reason: nil
                )
            ),
            presenterHost: MissingSnapshotPresenterHost()
        )

        _ = try service.createProtectedSession(Layer3CreateProtectedSessionRequest(sessionId: "v2", presentationMode: .nativeFullscreenPresenter, displayPreference: .dedicatedDisplay, reason: "validation-run"))
        _ = try service.attachSurface(Layer3AttachSurfaceRequest(sessionId: "v2", surfaceSource: "native-ui-host", surfaceId: "surface-v2", width: 1280, height: 720, hiDpi: true))
        _ = try service.present(Layer3PresentRequest(sessionId: "v2", activate: true))

        let result = try service.validateSession(sessionId: "v2")

        XCTAssertEqual(result.outcome, .blocked)
        XCTAssertEqual(result.blockers.first?.code, "native-presenter-unavailable")
    }

    func testCreateProtectedSessionFailsIfPreviousPresenterCleanupFails() throws {
        let host = FailingPresenterHost(failOnTeardown: true)
        let service = VirtualDisplayService(
            backend: SuccessfulBackend(),
            sessionStore: InMemorySessionStore(),
            layer3Probe: StubLayer3Probe(
                report: Layer3CandidateReport(
                    status: .proven,
                    candidateRenderer: "apple-native-metal-presenter",
                    osVersion: "14.4.0",
                    cgVirtualDisplayAvailable: true,
                    metalDeviceAvailable: true,
                    metalCommandQueueAvailable: true,
                    screenCaptureKitAvailable: true,
                    reason: nil
                )
            ),
            presenterHost: host
        )

        _ = try service.createProtectedSession(Layer3CreateProtectedSessionRequest(sessionId: "dup-fail", presentationMode: .nativeFullscreenPresenter, displayPreference: .dedicatedDisplay, reason: "validation-run"))
        _ = try service.attachSurface(Layer3AttachSurfaceRequest(sessionId: "dup-fail", surfaceSource: "native-ui-host", surfaceId: "surface-a", width: 800, height: 600, hiDpi: false))

        XCTAssertThrowsError(
            try service.createProtectedSession(Layer3CreateProtectedSessionRequest(sessionId: "dup-fail", presentationMode: .nativeFullscreenPresenter, displayPreference: .dedicatedDisplay, reason: "validation-run"))
        )
    }

    func testFileLayer3TelemetryStorePersistsAcrossInstances() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let telemetryURL = directory.appendingPathComponent("telemetry.json")

        let writer = FileLayer3TelemetryStore(fileURL: telemetryURL)
        try writer.record(sessionId: "persist", type: "session-created", detail: "native-fullscreen-presenter", at: "2026-03-30T12:00:00Z")

        let reader = FileLayer3TelemetryStore(fileURL: telemetryURL)
        let report = try reader.report(sessionId: "persist")

        XCTAssertEqual(report.events.count, 1)
        XCTAssertEqual(report.events.first?.type, "session-created")
    }

    func testParseCreateProtectedSessionRequestRejectsInvalidEnumValues() {
        XCTAssertThrowsError(
            try parseCreateProtectedSessionRequest([
                "sessionId": "bad-1",
                "presentationMode": "bad-mode",
                "displayPreference": "dedicated-display",
                "reason": "validation-run",
            ])
        )
    }

    func testParseAttachSurfaceRequestRejectsMissingSurfaceSource() {
        XCTAssertThrowsError(
            try parseAttachSurfaceRequest([
                "sessionId": "bad-2",
                "surfaceId": "surface-x",
                "width": 1280,
                "height": 720,
                "hiDpi": true,
            ])
        )
    }

    func testTeardownProtectedSessionReleasesPresenterHost() throws {
        let host = RecordingPresenterHost()
        let service = VirtualDisplayService(
            backend: SuccessfulBackend(),
            sessionStore: InMemorySessionStore(),
            layer3Probe: StubLayer3Probe(
                report: Layer3CandidateReport(
                    status: .proven,
                    candidateRenderer: "apple-native-metal-presenter",
                    osVersion: "14.4.0",
                    cgVirtualDisplayAvailable: true,
                    metalDeviceAvailable: true,
                    metalCommandQueueAvailable: true,
                    screenCaptureKitAvailable: true,
                    reason: nil
                )
            ),
            presenterHost: host
        )

        _ = try service.createProtectedSession(Layer3CreateProtectedSessionRequest(sessionId: "p5", presentationMode: .nativeFullscreenPresenter, displayPreference: .dedicatedDisplay, reason: "validation-run"))
        _ = try service.attachSurface(Layer3AttachSurfaceRequest(sessionId: "p5", surfaceSource: "native-ui-host", surfaceId: "surface-5", width: 1280, height: 720, hiDpi: true))
        let response = try service.teardownProtectedSession(sessionId: "p5")

        XCTAssertEqual(response.outcome, .ok)
        XCTAssertEqual(response.data.released, true)
        XCTAssertEqual(host.teardownCalls, ["p5"])
    }

    func testAppKitPresenterHostCreatesShowsHidesAndClosesWindow() throws {
        let factory = RecordingPresenterWindowFactory()
        let host = AppKitMetalPresenterHost(windowFactory: factory)

        try host.attachSurface(sessionId: "host-1", surfaceId: "surface-host", displayToken: nil, width: 1280, height: 720, hiDpi: true)
        try host.setPresentationActive(sessionId: "host-1", active: true)
        try host.setPresentationActive(sessionId: "host-1", active: false)
        try host.teardown(sessionId: "host-1")

        XCTAssertEqual(factory.createCalls.count, 1)
        XCTAssertEqual(factory.createCalls.first?.surfaceId, "surface-host")
        XCTAssertEqual(factory.window.showCount, 1)
        XCTAssertEqual(factory.window.hideCount, 1)
        XCTAssertEqual(factory.window.closeCount, 1)
        XCTAssertEqual(factory.window.drawableSize.width, 1280)
        XCTAssertEqual(factory.window.drawableSize.height, 720)
    }

    func testAppKitPresenterHostRejectsUnresolvableDisplayToken() {
        let host = AppKitMetalPresenterHost()

        XCTAssertThrowsError(
            try host.attachSurface(sessionId: "host-2", surfaceId: "surface-host", displayToken: "display-999999", width: 1280, height: 720, hiDpi: true)
        )
    }
}

private struct SuccessfulBackend: VirtualDisplayBackend {
    func createSession(_ request: SessionRequest) throws -> BackendCreateResult {
        BackendCreateResult(
            ready: true,
            displayName: "InternalDisplay",
            surfaceToken: "display-77",
            reason: nil
        )
    }

    func releaseSession(sessionId: String) throws {}

    func status() -> [String : Any] {
        [
            "ready": true,
            "component": "macos-virtual-display-helper",
            "backend": "successful-test"
        ]
    }
}

private struct FakeLayer3Environment: Layer3CapabilityEnvironment {
    let osVersion: OperatingSystemVersion
    let cgVirtualDisplayAvailable: Bool
    let metalDeviceAvailable: Bool
    let metalCommandQueueAvailable: Bool
    let screenCaptureKitAvailable: Bool
    let screenRecordingPermission: String
}

private struct StubLayer3Probe: Layer3CapabilityProbing {
    let report: Layer3CandidateReport

    func probe() -> Layer3CandidateReport {
        report
    }
}

private struct StubLayer3ValidationProbe: Layer3ValidationProbing {
    let report: Layer3ValidationReport

    func validate(snapshot: Layer3PresenterValidationSnapshot) -> Layer3ValidationReport {
        report
    }
}

private struct StubWindowMetadataProvider: Layer3WindowMetadataProviding {
    let windows: [Layer3WindowMetadata]

    func currentWindows() -> [Layer3WindowMetadata] { windows }
}

private struct StubShareableContentProvider: Layer3ShareableContentProviding {
    let windows: [Layer3WindowMetadata]

    func currentWindows() -> [Layer3WindowMetadata] { windows }
}

private final class RecordingPresenterHost: Layer3PresenterHosting {
    var attachedSurfaceIds: [String] = []
    var presentCalls: [String] = []
    var teardownCalls: [String] = []

    func attachSurface(sessionId: String, surfaceId: String, displayToken: String?, width: Int, height: Int, hiDpi: Bool) throws {
        attachedSurfaceIds.append(surfaceId)
    }

    func setPresentationActive(sessionId: String, active: Bool) throws {
        presentCalls.append("\(sessionId):\(active)")
    }

    func teardown(sessionId: String) throws {
        teardownCalls.append(sessionId)
    }

    func validationSnapshot(sessionId: String) throws -> Layer3PresenterValidationSnapshot {
        Layer3PresenterValidationSnapshot(sessionId: sessionId, windowTitle: "Layer3Presenter-\(sessionId)", windowNumber: 1, active: true)
    }
}

private final class FailingPresenterHost: Layer3PresenterHosting {
    let failOnAttach: Bool
    let failOnTeardown: Bool

    init(failOnAttach: Bool = false, failOnTeardown: Bool = false) {
        self.failOnAttach = failOnAttach
        self.failOnTeardown = failOnTeardown
    }

    func attachSurface(sessionId: String, surfaceId: String, displayToken: String?, width: Int, height: Int, hiDpi: Bool) throws {
        if failOnAttach {
            throw NSError(domain: "Layer3PresenterHost", code: 99, userInfo: [NSLocalizedDescriptionKey: "attach failed"])
        }
    }

    func setPresentationActive(sessionId: String, active: Bool) throws {}

    func teardown(sessionId: String) throws {
        if failOnTeardown {
            throw NSError(domain: "Layer3PresenterHost", code: 100, userInfo: [NSLocalizedDescriptionKey: "teardown failed"])
        }
    }

    func validationSnapshot(sessionId: String) throws -> Layer3PresenterValidationSnapshot {
        Layer3PresenterValidationSnapshot(sessionId: sessionId, windowTitle: "Layer3Presenter-\(sessionId)", windowNumber: 1, active: true)
    }
}

private final class ValidationSnapshotPresenterHost: Layer3PresenterHosting {
    let snapshot: Layer3PresenterValidationSnapshot

    init(snapshot: Layer3PresenterValidationSnapshot) {
        self.snapshot = snapshot
    }

    func attachSurface(sessionId: String, surfaceId: String, displayToken: String?, width: Int, height: Int, hiDpi: Bool) throws {}
    func setPresentationActive(sessionId: String, active: Bool) throws {}
    func teardown(sessionId: String) throws {}
    func validationSnapshot(sessionId: String) throws -> Layer3PresenterValidationSnapshot { snapshot }
}

private final class MissingSnapshotPresenterHost: Layer3PresenterHosting {
    func attachSurface(sessionId: String, surfaceId: String, displayToken: String?, width: Int, height: Int, hiDpi: Bool) throws {}
    func setPresentationActive(sessionId: String, active: Bool) throws {}
    func teardown(sessionId: String) throws {}
    func validationSnapshot(sessionId: String) throws -> Layer3PresenterValidationSnapshot {
        throw NSError(domain: "Layer3PresenterHost", code: 404, userInfo: [NSLocalizedDescriptionKey: "snapshot missing"])
    }
}

private final class RecordingPresenterWindowFactory: Layer3PresenterWindowFactory {
    struct CreateCall {
        let sessionId: String
        let surfaceId: String
        let displayToken: String?
        let width: Int
        let height: Int
        let hiDpi: Bool
    }

    let window = RecordingPresenterWindow()
    var createCalls: [CreateCall] = []

    func makeWindow(sessionId: String, surfaceId: String, displayToken: String?, width: Int, height: Int, hiDpi: Bool) throws -> Layer3PresenterWindow {
        createCalls.append(.init(sessionId: sessionId, surfaceId: surfaceId, displayToken: displayToken, width: width, height: height, hiDpi: hiDpi))
        return window
    }
}

private final class RecordingPresenterWindow: Layer3PresenterWindow {
    var showCount = 0
    var hideCount = 0
    var closeCount = 0
    var drawableSize = CGSize.zero

    func configureDrawableSize(width: Int, height: Int, hiDpi: Bool) throws {
        drawableSize = CGSize(width: width, height: height)
    }

    func windowNumber() throws -> Int { 77 }

    func title() throws -> String { "Layer3Presenter-test" }

    func show() throws {
        showCount += 1
    }

    func hide() throws {
        hideCount += 1
    }

    func close() throws {
        closeCount += 1
    }
}
