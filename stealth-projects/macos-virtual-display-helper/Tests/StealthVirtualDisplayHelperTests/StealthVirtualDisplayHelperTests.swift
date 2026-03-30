import XCTest
@testable import StealthVirtualDisplayHelper

final class StealthVirtualDisplayHelperTests: XCTestCase {
    func testCGVirtualDisplayBackendVersionGateMatchesPlanMinimum() {
        XCTAssertTrue(CGVirtualDisplayBackend.supportsOperatingSystemVersion(.init(majorVersion: 12, minorVersion: 4, patchVersion: 0)))
        XCTAssertFalse(CGVirtualDisplayBackend.supportsOperatingSystemVersion(.init(majorVersion: 12, minorVersion: 3, patchVersion: 9)))
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
