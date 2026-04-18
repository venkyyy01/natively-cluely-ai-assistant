import Foundation
import FoundationModels

private struct IntentRequest: Decodable {
    let version: Int
    let question: String
    let preparedTranscript: String
    let assistantResponseCount: Int
    let candidateIntents: [String]
}

private struct IntentResponse: Encodable {
    let ok: Bool
    let intent: String?
    let confidence: Double?
    let answerShape: String?
    let provider: String?
    let errorType: String?
    let message: String?

    static func success(intent: String, confidence: Double, answerShape: String) -> IntentResponse {
        IntentResponse(
            ok: true,
            intent: intent,
            confidence: confidence,
            answerShape: answerShape,
            provider: "apple_foundation_models",
            errorType: nil,
            message: nil
        )
    }

    static func failure(errorType: String, message: String) -> IntentResponse {
        IntentResponse(
            ok: false,
            intent: nil,
            confidence: nil,
            answerShape: nil,
            provider: nil,
            errorType: errorType,
            message: message
        )
    }
}

@available(macOS 26.0, *)
@Generable
private struct IntentEnvelope {
    var intent: String

    var confidence: Double

    var answerShape: String
}

private enum HelperError: Error {
    case invalidRequest(String)
    case unavailable(String)
    case invalidResponse(String)
    case refusal(String)
    case timeout(String)
    case unknown(String)

    var type: String {
        switch self {
        case .invalidRequest, .invalidResponse:
            return "invalid_response"
        case .unavailable:
            return "unavailable"
        case .refusal:
            return "refusal"
        case .timeout:
            return "timeout"
        case .unknown:
            return "unknown"
        }
    }

    var message: String {
        switch self {
        case let .invalidRequest(message),
             let .unavailable(message),
             let .invalidResponse(message),
             let .refusal(message),
             let .timeout(message),
             let .unknown(message):
            return message
        }
    }
}

private func writeResponse(_ response: IntentResponse) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    do {
        let data = try encoder.encode(response)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        let fallback = "{\"ok\":false,\"errorType\":\"unknown\",\"message\":\"Failed to encode helper response\"}\n"
        FileHandle.standardOutput.write(Data(fallback.utf8))
    }
}

private func parseRequest() throws -> IntentRequest {
    let data = try FileHandle.standardInput.readToEnd() ?? Data()
    guard !data.isEmpty else {
        throw HelperError.invalidRequest("Empty request payload")
    }

    let decoder = JSONDecoder()
    let request = try decoder.decode(IntentRequest.self, from: data)
    guard request.version == 1 else {
        throw HelperError.invalidRequest("Unsupported request version")
    }
    guard !request.candidateIntents.isEmpty else {
        throw HelperError.invalidRequest("candidateIntents must be non-empty")
    }
    return request
}

@available(macOS 26.0, *)
private func availabilityErrorMessage(_ availability: SystemLanguageModel.Availability) -> String {
    switch availability {
    case .available:
        return ""
    case .unavailable(let reason):
        return "Model unavailable: \(String(describing: reason))"
    }
}

@available(macOS 26.0, *)
private func ensureModelAvailable(_ model: SystemLanguageModel) throws {
    guard model.isAvailable else {
        let message = availabilityErrorMessage(model.availability)
        throw HelperError.unavailable(message.isEmpty ? "System language model unavailable" : message)
    }
}

@available(macOS 26.0, *)
private func buildPrompt(_ request: IntentRequest) -> Prompt {
    let candidates = request.candidateIntents.joined(separator: ", ")
    return Prompt("""
    Classify the interviewer question intent for an interview copilot.

    Allowed intents: \(candidates)

    Interviewer question:
    \(request.question)

    Prepared transcript context:
    \(request.preparedTranscript)

    Assistant response count so far: \(request.assistantResponseCount)

    Return only the best matching intent, confidence 0..1, and one short answer-shape sentence.
    """)
}

@available(macOS 26.0, *)
private func classifyIntent(_ request: IntentRequest) async throws -> IntentEnvelope {
    let model = SystemLanguageModel.default
    try ensureModelAvailable(model)

    let instructions = Instructions("""
    You are a strict intent classifier for interview coaching.
    Output exactly one allowed intent label.
    Keep confidence calibrated.
    Keep answerShape concise.
    """)

    let session = LanguageModelSession(model: model, instructions: instructions)

    do {
        let response = try await session.respond(
            generating: IntentEnvelope.self,
            includeSchemaInPrompt: true,
            options: GenerationOptions(temperature: 0),
            prompt: {
                buildPrompt(request)
            }
        )
        return response.content
    } catch {
        let message = String(describing: error)
        if message.localizedCaseInsensitiveContains("refus") {
            throw HelperError.refusal(message)
        }
        if message.localizedCaseInsensitiveContains("timeout") {
            throw HelperError.timeout(message)
        }
        if message.localizedCaseInsensitiveContains("unavailable") {
            throw HelperError.unavailable(message)
        }
        throw HelperError.unknown(message)
    }
}

@available(macOS 26.0, *)
private func runHelper() async {
    do {
        let request = try parseRequest()
        let result = try await classifyIntent(request)
        let candidateSet = Set(request.candidateIntents)
        guard candidateSet.contains(result.intent) else {
            throw HelperError.invalidResponse("Model returned intent outside candidate set")
        }

        let normalizedConfidence = max(0.0, min(1.0, result.confidence))
        writeResponse(
            .success(
                intent: result.intent,
                confidence: normalizedConfidence,
                answerShape: result.answerShape.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        )
    } catch let error as HelperError {
        writeResponse(.failure(errorType: error.type, message: error.message))
    } catch {
        writeResponse(.failure(errorType: "unknown", message: String(describing: error)))
    }
}

@main
struct FoundationIntentHelperMain {
    static func main() async {
        if #available(macOS 26.0, *) {
            await runHelper()
        } else {
            writeResponse(.failure(errorType: "unavailable", message: "Foundation Models intent helper requires macOS 26+"))
        }
    }
}
