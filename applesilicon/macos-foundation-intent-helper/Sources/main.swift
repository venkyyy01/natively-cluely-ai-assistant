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

    static func success(intent: String, confidence: Double) -> IntentResponse {
        IntentResponse(
            ok: true,
            intent: intent,
            confidence: confidence,
            answerShape: nil,
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
@Generable(description: "Interview intent label and confidence.")
private struct IntentEnvelope {
    @Guide(description: "Best intent label for the interviewer turn.", .anyOf([
        "behavioral",
        "coding",
        "deep_dive",
        "clarification",
        "follow_up",
        "example_request",
        "summary_probe",
        "general"
    ]))
    var intent: String

    @Guide(description: "Confidence from 0 to 1.")
    var confidence: Double
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
private func questionSpecificHint(for question: String) -> String {
    let lowered = question.lowercased()
    var hints: [String] = []

    if lowered.hasPrefix("so ") || lowered.contains("so you're saying") || lowered.contains("so you are saying") || lowered.contains("let me make sure") {
        hints.append("This question restates prior discussion for confirmation. Prefer summary_probe over follow_up if it paraphrases the earlier answer.")
    }

    if lowered.contains("what happened next") || lowered.contains("then what") || lowered.contains("after that") {
        hints.append("This question asks for continuation. Prefer follow_up.")
    }

    if lowered.contains("tradeoff") || lowered.contains("trade-off") || lowered.contains("why would you choose") || lowered.contains("why choose") || lowered.contains("why not") || lowered.contains("compare") {
        hints.append("This question asks for reasoning or tradeoffs. Prefer deep_dive unless it explicitly asks for code.")
    }

    return hints.joined(separator: " ")
}

@available(macOS 26.0, *)
private func buildPrompt(_ request: IntentRequest) -> Prompt {
    let recentDialogue = request.preparedTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
    let priorAnswerHint = request.assistantResponseCount > 0
        ? "There is prior assistant context. Use it only for follow_up, clarification, or summary_probe."
        : "There is no prior assistant context. Avoid follow_up or summary_probe unless the wording explicitly depends on missing context."
    let questionHint = questionSpecificHint(for: request.question)
    return Prompt("""
    Classify the interviewer turn into one interview intent label.

    behavioral: asks about the candidate's own past actions, decisions, conflict, leadership, failure, or work example.
    coding: asks for code, debugging, implementation, algorithms, technical design, or architecture.
    deep_dive: asks for deeper explanation, reasoning, or tradeoffs without asking for code.
    clarification: asks to clarify or explain something already said.
    follow_up: asks to continue the immediately previous answer or asks what happened next.
    example_request: asks for a concrete example or instance without asking for a full past story.
    summary_probe: restates prior discussion and asks for confirmation or correction.
    general: anything else.

    Simple examples:
    - "Tell me about a time you handled a difficult stakeholder." -> behavioral
    - "Implement an LRU cache in TypeScript." -> coding
    - "Why would you choose Kafka over RabbitMQ in this design?" -> deep_dive
    - "Can you clarify what you mean by backpressure?" -> clarification
    - "What happened next after the rollback?" -> follow_up
    - "Can you give a concrete example?" -> example_request
    - "So you are saying the write path stays synchronous?" -> summary_probe
    - "What interests you about this role?" -> general

    \(priorAnswerHint)
    \(questionHint.isEmpty ? "" : "Question-specific hint: \(questionHint)")

    Current interviewer turn:
    \(request.question)

    Recent dialogue:
    \(recentDialogue.isEmpty ? "[none]" : recentDialogue)

    Return the best label and a calibrated confidence.
    """)
}

@available(macOS 26.0, *)
private func classifyIntent(_ request: IntentRequest) async throws -> IntentEnvelope {
    let model = SystemLanguageModel(useCase: .general)
    try ensureModelAvailable(model)

    let instructions = Instructions("""
    You are a precise intent classifier for interview coaching.
    Output exactly one label from the guided schema.
    Keep confidence calibrated.
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
                confidence: normalizedConfidence
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
