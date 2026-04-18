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

private protocol IntentLabelEnvelope {
    var intent: String { get }
    var confidence: Double { get }
}

@available(macOS 26.0, *)
@Generable(description: "Behavioral-profile intent label and confidence.")
private struct BehavioralIntentEnvelope: IntentLabelEnvelope {
    @Guide(description: "Intent label for behavioral profile.", .anyOf([
        "behavioral",
        "example_request",
        "general"
    ]))
    var intent: String

    @Guide(description: "Confidence from 0 to 1.")
    var confidence: Double
}

@available(macOS 26.0, *)
@Generable(description: "Coding-profile intent label and confidence.")
private struct CodingIntentEnvelope: IntentLabelEnvelope {
    @Guide(description: "Intent label for coding profile.", .anyOf([
        "coding",
        "deep_dive",
        "clarification",
        "general"
    ]))
    var intent: String

    @Guide(description: "Confidence from 0 to 1.")
    var confidence: Double
}

@available(macOS 26.0, *)
@Generable(description: "Contextual-profile intent label and confidence.")
private struct ContextualIntentEnvelope: IntentLabelEnvelope {
    @Guide(description: "Intent label for contextual profile.", .anyOf([
        "clarification",
        "follow_up",
        "summary_probe",
        "example_request",
        "deep_dive",
        "general"
    ]))
    var intent: String

    @Guide(description: "Confidence from 0 to 1.")
    var confidence: Double
}

@available(macOS 26.0, *)
@Generable(description: "General-profile intent label and confidence.")
private struct GeneralIntentEnvelope: IntentLabelEnvelope {
    @Guide(description: "Intent label for general profile.", .anyOf([
        "general",
        "behavioral",
        "coding",
        "deep_dive"
    ]))
    var intent: String

    @Guide(description: "Confidence from 0 to 1.")
    var confidence: Double
}

@available(macOS 26.0, *)
@Generable(description: "Primary intent family and confidence.")
private struct IntentFamilyEnvelope {
    @Guide(description: "Broad intent family.", .anyOf([
        "behavioral",
        "coding",
        "contextual",
        "general"
    ]))
    var family: String

    @Guide(description: "Confidence from 0 to 1.")
    var confidence: Double
}

private enum IntentProfile {
    case behavioral
    case coding
    case contextual
    case general

    var allowedIntents: [String] {
        switch self {
        case .behavioral:
            return ["behavioral", "example_request", "general"]
        case .coding:
            return ["coding", "deep_dive", "clarification", "general"]
        case .contextual:
            return ["clarification", "follow_up", "summary_probe", "example_request", "deep_dive", "general"]
        case .general:
            return ["general", "behavioral", "coding", "deep_dive"]
        }
    }

    var promptBlock: String {
        switch self {
        case .behavioral:
            return """
            Use this shortlist only: behavioral, example_request, general.
            Pick behavioral for past experience prompts ("tell me about a time", "describe a situation", conflict, leadership, failure).
            Pick example_request only when interviewer asks for a concrete example of an idea without asking for a full past story.
            """
        case .coding:
            return """
            Use this shortlist only: coding, deep_dive, clarification, general.
            Pick coding for implementation, debugging, writing code, algorithms, or API handler details.
            Pick deep_dive for technical tradeoff reasoning without requesting code.
            Pick clarification only when interviewer asks to clarify prior answer wording.
            """
        case .contextual:
            return """
            Use this shortlist only: clarification, follow_up, summary_probe, example_request, deep_dive, general.
            Pick follow_up for continuation prompts ("what happened next", "then what", "after that").
            Pick summary_probe when interviewer restates prior answer for confirmation ("so you are saying", "let me make sure", "to summarize").
            Pick clarification for unpack/explain wording prompts.
            """
        case .general:
            return """
            Use this shortlist only: general, behavioral, coding, deep_dive.
            Prefer general unless the wording clearly requests personal past experience, code implementation, or technical tradeoff reasoning.
            """
        }
    }

    static func fromFamily(_ family: String) -> IntentProfile {
        switch family {
        case "behavioral":
            return .behavioral
        case "coding":
            return .coding
        case "contextual":
            return .contextual
        default:
            return .general
        }
    }
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

private func normalizeQuestion(_ question: String) -> String {
    question
        .lowercased()
        .replacingOccurrences(of: "[^a-z0-9\\s]", with: " ", options: .regularExpression)
}

private func inferHeuristicProfile(question: String, assistantResponseCount: Int) -> IntentProfile {
    let lowered = normalizeQuestion(question)

    let behavioralCue = lowered.contains("tell me about a time")
        || lowered.contains("describe a time")
        || lowered.contains("describe a situation")
        || lowered.contains("walk me through a failure")
        || lowered.contains("influence")
        || lowered.contains("stakeholder")
        || lowered.contains("leadership")

    if behavioralCue {
        return .behavioral
    }

    let codingCue = lowered.contains("implement")
        || lowered.contains("write code")
        || lowered.contains("debug")
        || lowered.contains("algorithm")
        || lowered.contains("lru")
        || lowered.contains("typescript")
        || lowered.contains("api payload")
        || lowered.contains("handler code")

    if codingCue {
        return .coding
    }

    let deepDiveCue = lowered.contains("tradeoff")
        || lowered.contains("trade off")
        || lowered.contains("why would you choose")
        || lowered.contains("why choose")
        || lowered.contains("why not")
        || lowered.contains("compare")
        || lowered.contains("consistency")
        || lowered.contains("availability")

    if deepDiveCue {
        return .coding
    }

    let contextualCue = lowered.contains("what happened next")
        || lowered.contains("then what")
        || lowered.contains("after that")
        || lowered.contains("clarify")
        || lowered.contains("what do you mean")
        || lowered.contains("unpack")
        || lowered.contains("so you are saying")
        || lowered.contains("let me make sure")
        || lowered.contains("to summarize")

    if contextualCue || assistantResponseCount > 0 {
        return .contextual
    }

    return .general
}

private func inferLikelyIntent(question: String, assistantResponseCount: Int) -> String? {
    let lowered = normalizeQuestion(question)
    if lowered.isEmpty {
        return nil
    }

    if lowered.contains("implement")
        || lowered.contains("write code")
        || lowered.contains("debug")
        || lowered.contains("algorithm")
        || lowered.contains("lru")
        || lowered.contains("typescript")
        || lowered.contains("javascript")
        || lowered.contains("handler code") {
        return "coding"
    }

    if lowered.contains("so you are saying")
        || lowered.contains("so you re saying")
        || lowered.contains("let me make sure")
        || lowered.contains("to summarize")
        || lowered.contains("so to summarize") {
        return "summary_probe"
    }

    if lowered.contains("what happened next")
        || lowered.contains("then what")
        || lowered.contains("after that") {
        return "follow_up"
    }

    if lowered.contains("clarify")
        || lowered.contains("what do you mean")
        || lowered.contains("unpack")
        || lowered.contains("can you explain") {
        return "clarification"
    }

    if lowered.contains("concrete example")
        || lowered.contains("specific example")
        || lowered.contains("for example")
        || lowered.contains("for instance") {
        return "example_request"
    }

    if lowered.contains("tell me about a time")
        || lowered.contains("describe a time")
        || lowered.contains("describe a situation")
        || lowered.contains("walk me through a failure")
        || lowered.contains("stakeholder")
        || lowered.contains("leadership")
        || lowered.contains("influence")
        || lowered.contains("conflict") {
        return "behavioral"
    }

    if lowered.contains("tradeoff")
        || lowered.contains("trade off")
        || lowered.contains("why would you choose")
        || lowered.contains("why choose")
        || lowered.contains("why not")
        || lowered.contains("compare")
        || lowered.contains("consistency")
        || lowered.contains("availability") {
        return "deep_dive"
    }

    if assistantResponseCount > 0 {
        return "follow_up"
    }

    return nil
}

private func calibrateConfidence(
    request: IntentRequest,
    predictedIntent: String,
    baseConfidence: Double
) -> Double {
    let lowered = normalizeQuestion(request.question)
    var confidence = max(0.0, min(1.0, baseConfidence))
    let likelyIntent = inferLikelyIntent(question: request.question, assistantResponseCount: request.assistantResponseCount)

    if let likelyIntent, likelyIntent != predictedIntent {
        confidence = min(confidence, 0.58)
    }

    if request.assistantResponseCount == 0 && (predictedIntent == "follow_up" || predictedIntent == "summary_probe") {
        confidence = min(confidence, 0.45)
    }

    if predictedIntent == "behavioral" {
        let hasContextualCue = lowered.contains("what happened next")
            || lowered.contains("then what")
            || lowered.contains("after that")
            || lowered.contains("so you are saying")
            || lowered.contains("let me make sure")
            || lowered.contains("to summarize")
            || lowered.contains("clarify")
            || lowered.contains("what do you mean")
        if hasContextualCue {
            confidence = min(confidence, 0.5)
        }
    }

    if predictedIntent == "general" {
        let hasStrongCue = inferLikelyIntent(question: request.question, assistantResponseCount: request.assistantResponseCount) != nil
        if hasStrongCue {
            confidence = min(confidence, 0.55)
        }
    }

    return max(0.0, min(1.0, confidence))
}

@available(macOS 26.0, *)
private func buildFamilyPrompt(_ request: IntentRequest) -> Prompt {
    let recentDialogue = request.preparedTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
    return Prompt("""
    Classify this interviewer turn into one broad family.

    behavioral: asks about candidate past actions, decisions, conflict, leadership, failure, or work example.
    coding: asks for implementation, code, debugging, algorithms, APIs, or technical build details.
    contextual: asks to clarify prior answer, continue the prior answer, summarize prior answer, or request concrete example from prior answer.
    general: everything else.

    Current interviewer turn:
    \(request.question)

    Recent dialogue:
    \(recentDialogue.isEmpty ? "[none]" : recentDialogue)
    """)
}

@available(macOS 26.0, *)
private func classifyProfile<T: IntentLabelEnvelope & Generable>(
    request: IntentRequest,
    session: LanguageModelSession,
    envelope: T.Type,
    profile: IntentProfile
) async throws -> IntentEnvelope {
    do {
        let response = try await session.respond(
            generating: envelope,
            includeSchemaInPrompt: true,
            options: GenerationOptions(temperature: 0),
            prompt: {
                buildProfilePrompt(request, profile: profile)
            }
        )

        return IntentEnvelope(
            intent: response.content.intent,
            confidence: response.content.confidence
        )
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
private func buildProfilePrompt(_ request: IntentRequest, profile: IntentProfile) -> Prompt {
    let recentDialogue = request.preparedTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
    let priorAnswerHint = request.assistantResponseCount > 0
        ? "There is prior assistant context. Contextual intents are allowed when wording depends on prior answer."
        : "There is no prior assistant context. Avoid follow_up or summary_probe unless explicitly implied by wording."
    let questionHint = questionSpecificHint(for: request.question)
    let allowed = profile.allowedIntents.joined(separator: ", ")
    return Prompt("""
    Classify the interviewer turn into one intent label.

    Allowed intents for this classification profile: \(allowed)

    behavioral: asks about the candidate's own past actions, decisions, conflict, leadership, failure, or work example.
    coding: asks for code, debugging, implementation, algorithms, technical design, or architecture.
    deep_dive: asks for deeper explanation, reasoning, or tradeoffs without asking for code.
    clarification: asks to clarify or explain something already said.
    follow_up: asks to continue the immediately previous answer or asks what happened next.
    example_request: asks for a concrete example or instance without asking for a full past story.
    summary_probe: restates prior discussion and asks for confirmation or correction.
    general: anything else.

    \(profile.promptBlock)
    \(priorAnswerHint)
    \(questionHint.isEmpty ? "" : "Question-specific hint: \(questionHint)")

    Current interviewer turn:
    \(request.question)

    Recent dialogue:
    \(recentDialogue.isEmpty ? "[none]" : recentDialogue)
    """)
}

@available(macOS 26.0, *)
private func classifyIntentFamily(
    request: IntentRequest,
    session: LanguageModelSession
) async throws -> IntentFamilyEnvelope {
    do {
        let response = try await session.respond(
            generating: IntentFamilyEnvelope.self,
            includeSchemaInPrompt: true,
            options: GenerationOptions(temperature: 0),
            prompt: {
                buildFamilyPrompt(request)
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
private func classifyIntent(_ request: IntentRequest) async throws -> IntentEnvelope {
    let model = SystemLanguageModel(useCase: .general)
    try ensureModelAvailable(model)

    let instructions = Instructions("""
    You are a precise intent classifier for interview coaching.
    Output exactly one label from the guided schema.
    Keep confidence calibrated.
    """)

    let session = LanguageModelSession(model: model, instructions: instructions)

    let heuristicProfile = inferHeuristicProfile(
        question: request.question,
        assistantResponseCount: request.assistantResponseCount
    )

    let selectedProfile: IntentProfile
    if heuristicProfile != .general {
        selectedProfile = heuristicProfile
    } else {
        let family: IntentFamilyEnvelope?
        do {
            family = try await classifyIntentFamily(request: request, session: session)
        } catch {
            family = nil
        }

        if let family, family.confidence >= 0.78 {
            selectedProfile = IntentProfile.fromFamily(family.family)
        } else {
            selectedProfile = .general
        }
    }

    switch selectedProfile {
    case .behavioral:
        return try await classifyProfile(
            request: request,
            session: session,
            envelope: BehavioralIntentEnvelope.self,
            profile: selectedProfile
        )
    case .coding:
        return try await classifyProfile(
            request: request,
            session: session,
            envelope: CodingIntentEnvelope.self,
            profile: selectedProfile
        )
    case .contextual:
        return try await classifyProfile(
            request: request,
            session: session,
            envelope: ContextualIntentEnvelope.self,
            profile: selectedProfile
        )
    case .general:
        return try await classifyProfile(
            request: request,
            session: session,
            envelope: GeneralIntentEnvelope.self,
            profile: selectedProfile
        )
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

        let normalizedConfidence = calibrateConfidence(
            request: request,
            predictedIntent: result.intent,
            baseConfidence: result.confidence
        )
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
