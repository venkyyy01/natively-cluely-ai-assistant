import Foundation

enum Command: String {
    case createSession = "create-session"
    case releaseSession = "release-session"
    case status = "status"
    case serve = "serve"
    case probeCapabilities = "probe-capabilities"
    case createProtectedSession = "create-protected-session"
    case attachSurface = "attach-surface"
    case present = "present"
    case teardownSession = "teardown-session"
    case getHealth = "get-health"
    case getTelemetry = "get-telemetry"
    case validateSession = "validate-session"
}

struct ReleaseRequest: Codable {
    let sessionId: String
}

struct SessionLookupRequest: Codable {
    let sessionId: String
}

let service = VirtualDisplayService(
    backend: makeDefaultVirtualDisplayBackend(),
    sessionStore: FileSessionStore(fileURL: stateFileURL()),
    telemetryStore: FileLayer3TelemetryStore(fileURL: telemetryFileURL())
)

let args = CommandLine.arguments
guard args.count >= 2, let command = Command(rawValue: args[1]) else {
    FileHandle.standardError.write(Data("usage: stealth-virtual-display-helper <create-session|release-session|status|probe-capabilities|create-protected-session|attach-surface|present|teardown-session|get-health|get-telemetry|validate-session>\n".utf8))
    Foundation.exit(64)
}

switch command {
case .createSession:
    let data = try FileHandle.standardInput.readToEnd() ?? Data()
    let request = try JSONDecoder().decode(SessionRequest.self, from: data)
    let response = try service.createSession(request)
    try writeJson(response.asJsonObject())
case .releaseSession:
    let data = try FileHandle.standardInput.readToEnd() ?? Data()
    let request = try JSONDecoder().decode(ReleaseRequest.self, from: data)
    try writeJson(try service.releaseSession(sessionId: request.sessionId).asJsonObject())
case .status:
    try writeJson(try service.status())
case .serve:
    try runServer(service: service)
case .probeCapabilities:
    try writeJson(service.probeCapabilities().asJsonObject())
case .createProtectedSession:
    let data = try FileHandle.standardInput.readToEnd() ?? Data()
    let request = try parseCreateProtectedSessionRequest(try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:])
    try writeJson(try service.createProtectedSession(request).asJsonObject())
case .attachSurface:
    let data = try FileHandle.standardInput.readToEnd() ?? Data()
    let request = try JSONDecoder().decode(Layer3AttachSurfaceRequest.self, from: data)
    try writeJson(try service.attachSurface(request).asJsonObject())
case .present:
    let data = try FileHandle.standardInput.readToEnd() ?? Data()
    let request = try JSONDecoder().decode(Layer3PresentRequest.self, from: data)
    try writeJson(try service.present(request).asJsonObject())
case .teardownSession:
    let data = try FileHandle.standardInput.readToEnd() ?? Data()
    let request = try JSONDecoder().decode(SessionLookupRequest.self, from: data)
    try writeJson(try service.teardownProtectedSession(sessionId: request.sessionId).asJsonObject())
case .getHealth:
    let data = try FileHandle.standardInput.readToEnd() ?? Data()
    let request = try JSONDecoder().decode(SessionLookupRequest.self, from: data)
    try writeJson(try service.health(sessionId: request.sessionId).asJsonObject())
case .getTelemetry:
    let data = try FileHandle.standardInput.readToEnd() ?? Data()
    let request = try JSONDecoder().decode(SessionLookupRequest.self, from: data)
    try writeJson(try service.telemetry(sessionId: request.sessionId).asJsonObject())
case .validateSession:
    let data = try FileHandle.standardInput.readToEnd() ?? Data()
    let request = try JSONDecoder().decode(SessionLookupRequest.self, from: data)
    try writeJson(try service.validateSession(sessionId: request.sessionId).asJsonObject())
}

private func writeJson(_ payload: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

private func stateFileURL() -> URL {
    if let override = ProcessInfo.processInfo.environment["STEALTH_VIRTUAL_DISPLAY_STATE_PATH"], !override.isEmpty {
        return URL(fileURLWithPath: override)
    }

    return FileManager.default.temporaryDirectory.appendingPathComponent("natively-stealth-virtual-display-sessions.json")
}

private func telemetryFileURL() -> URL {
    stateFileURL().deletingPathExtension().appendingPathExtension("telemetry.json")
}

private func runServer(service: VirtualDisplayService) throws {
    while let line = readLine() {
        guard !line.isEmpty else {
            continue
        }

        var requestId: String?
        do {
            guard let request = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
                try writeJson(["ok": false, "error": "Invalid request envelope"])
                continue
            }
            requestId = request["id"] as? String
            guard let id = requestId,
                  let commandName = request["command"] as? String,
                  let command = Command(rawValue: commandName)
            else {
                try writeJson(["id": requestId ?? NSNull(), "ok": false, "error": "Invalid request envelope"])
                continue
            }

            let result: [String: Any]
            switch command {
            case .createSession:
                result = try service.createSession(try parseSessionRequest(request)).asJsonObject()
            case .releaseSession:
                result = try service.releaseSession(sessionId: try parseSessionLookupRequest(request).sessionId).asJsonObject()
            case .status:
                result = try service.status()
            case .serve:
                result = ["ready": true]
            case .probeCapabilities:
                result = service.probeCapabilities().asJsonObject()
            case .createProtectedSession:
                result = try service.createProtectedSession(try parseCreateProtectedSessionRequest(request)).asJsonObject()
            case .attachSurface:
                result = try service.attachSurface(try parseAttachSurfaceRequest(request)).asJsonObject()
            case .present:
                result = try service.present(try parsePresentRequest(request)).asJsonObject()
            case .teardownSession:
                result = try service.teardownProtectedSession(sessionId: try parseSessionLookupRequest(request).sessionId).asJsonObject()
            case .getHealth:
                result = try service.health(sessionId: try parseSessionLookupRequest(request).sessionId).asJsonObject()
            case .getTelemetry:
                result = try service.telemetry(sessionId: try parseSessionLookupRequest(request).sessionId).asJsonObject()
            case .validateSession:
                result = try service.validateSession(sessionId: try parseSessionLookupRequest(request).sessionId).asJsonObject()
            }

            try writeJson(["id": id, "ok": true, "result": result])
        } catch {
            try writeJson(["id": requestId ?? NSNull(), "ok": false, "error": error.localizedDescription])
        }
    }
}
