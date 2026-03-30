import Foundation

enum Command: String {
    case createSession = "create-session"
    case releaseSession = "release-session"
    case status = "status"
    case serve = "serve"
}

struct ReleaseRequest: Codable {
    let sessionId: String
}

let service = VirtualDisplayService(
    backend: makeDefaultVirtualDisplayBackend(),
    sessionStore: FileSessionStore(fileURL: stateFileURL())
)

let args = CommandLine.arguments
guard args.count >= 2, let command = Command(rawValue: args[1]) else {
    FileHandle.standardError.write(Data("usage: stealth-virtual-display-helper <create-session|release-session|status>\n".utf8))
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

private func runServer(service: VirtualDisplayService) throws {
    while let line = readLine() {
        guard !line.isEmpty else {
            continue
        }

        do {
            guard let request = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  let id = request["id"] as? String,
                  let commandName = request["command"] as? String,
                  let command = Command(rawValue: commandName)
            else {
                try writeJson(["ok": false, "error": "Invalid request envelope"])
                continue
            }

            let result: [String: Any]
            switch command {
            case .createSession:
                let sessionId = request["sessionId"] as? String ?? UUID().uuidString
                let windowId = request["windowId"] as? String ?? sessionId
                let width = request["width"] as? Int ?? 0
                let height = request["height"] as? Int ?? 0
                result = try service.createSession(.init(sessionId: sessionId, windowId: windowId, width: width, height: height)).asJsonObject()
            case .releaseSession:
                let sessionId = request["sessionId"] as? String ?? ""
                result = try service.releaseSession(sessionId: sessionId).asJsonObject()
            case .status:
                result = try service.status()
            case .serve:
                result = ["ready": true]
            }

            try writeJson(["id": id, "ok": true, "result": result])
        } catch {
            try writeJson(["ok": false, "error": error.localizedDescription])
        }
    }
}
