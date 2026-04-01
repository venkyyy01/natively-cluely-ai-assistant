import Foundation

func parseCreateProtectedSessionRequest(_ request: [String: Any]) throws -> Layer3CreateProtectedSessionRequest {
    guard let sessionId = request["sessionId"] as? String, !sessionId.isEmpty else {
        throw NSError(domain: "ServerRequestParsing", code: 0, userInfo: [NSLocalizedDescriptionKey: "Missing sessionId"])
    }
    let presentationModeRaw = request["presentationMode"] as? String ?? Layer3PresentationMode.nativeFullscreenPresenter.rawValue
    let displayPreferenceRaw = request["displayPreference"] as? String ?? Layer3DisplayPreference.activeDisplay.rawValue
    let reason = request["reason"] as? String ?? "user-requested"

    guard let presentationMode = Layer3PresentationMode(rawValue: presentationModeRaw) else {
        throw NSError(domain: "ServerRequestParsing", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid presentationMode"])
    }

    guard let displayPreference = Layer3DisplayPreference(rawValue: displayPreferenceRaw) else {
        throw NSError(domain: "ServerRequestParsing", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid displayPreference"])
    }

    return Layer3CreateProtectedSessionRequest(
        sessionId: sessionId,
        presentationMode: presentationMode,
        displayPreference: displayPreference,
        reason: reason
    )
}

func parseSessionRequest(_ request: [String: Any]) throws -> SessionRequest {
    guard let sessionId = request["sessionId"] as? String,
          let windowId = request["windowId"] as? String,
          let width = request["width"] as? Int,
          let height = request["height"] as? Int
    else {
        throw NSError(domain: "ServerRequestParsing", code: 3, userInfo: [NSLocalizedDescriptionKey: "Invalid create-session request"])
    }

    return SessionRequest(sessionId: sessionId, windowId: windowId, width: width, height: height)
}

func parseAttachSurfaceRequest(_ request: [String: Any]) throws -> Layer3AttachSurfaceRequest {
    guard let sessionId = request["sessionId"] as? String,
          let surfaceSource = request["surfaceSource"] as? String,
          let surfaceId = request["surfaceId"] as? String,
          let width = request["width"] as? Int,
          let height = request["height"] as? Int,
          let hiDpi = request["hiDpi"] as? Bool
    else {
        throw NSError(domain: "ServerRequestParsing", code: 4, userInfo: [NSLocalizedDescriptionKey: "Invalid attach-surface request"])
    }

    return Layer3AttachSurfaceRequest(sessionId: sessionId, surfaceSource: surfaceSource, surfaceId: surfaceId, width: width, height: height, hiDpi: hiDpi)
}

func parsePresentRequest(_ request: [String: Any]) throws -> Layer3PresentRequest {
    guard let sessionId = request["sessionId"] as? String,
          let activate = request["activate"] as? Bool
    else {
        throw NSError(domain: "ServerRequestParsing", code: 5, userInfo: [NSLocalizedDescriptionKey: "Invalid present request"])
    }

    return Layer3PresentRequest(sessionId: sessionId, activate: activate)
}

func parseSessionLookupRequest(_ request: [String: Any]) throws -> SessionLookupRequest {
    guard let sessionId = request["sessionId"] as? String else {
        throw NSError(domain: "ServerRequestParsing", code: 6, userInfo: [NSLocalizedDescriptionKey: "Invalid session lookup request"])
    }

    return SessionLookupRequest(sessionId: sessionId)
}
