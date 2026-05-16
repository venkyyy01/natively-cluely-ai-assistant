import Foundation
import FoundationModels

private struct IntentRequest: Decodable {
    let requestId: String?
    let version: Int
    let question: String
    let preparedTranscript: String
    let assistantResponseCount: Int
    let promptVersion: String
    let schemaVersion: String
    let locale: String?
    let candidateIntents: [String]
}

private struct IntentResponse: Encodable {
    let requestId: String?
    let ok: Bool
    let intent: String?
    let confidence: Double?
    let answerShape: String?
    let provider: String?
    let promptVersion: String?
    let schemaVersion: String?
    let errorType: String?
    let message: String?

    static func success(requestId: String?, intent: String, confidence: Double, promptVersion: String, schemaVersion: String) -> IntentResponse {
        IntentResponse(
            requestId: requestId,
            ok: true,
            intent: intent,
            confidence: confidence,
            answerShape: nil,
            provider: "apple_foundation_models",
            promptVersion: promptVersion,
            schemaVersion: schemaVersion,
            errorType: nil,
            message: nil
        )
    }

    static func failure(requestId: String?, errorType: String, message: String) -> IntentResponse {
        IntentResponse(
            requestId: requestId,
            ok: false,
            intent: nil,
            confidence: nil,
            answerShape: nil,
            provider: nil,
            promptVersion: nil,
            schemaVersion: nil,
            errorType: errorType,
            message: message
        )
    }
}

private let helperSupportedPromptVersion = "foundation_intent_prompt_v2"
private let helperSupportedSchemaVersion = "foundation_intent_schema_v1"
private let helperSupportedIntents: Set<String> = [
    "behavioral",
    "coding",
    "deep_dive",
    "clarification",
    "follow_up",
    "example_request",
    "summary_probe",
    "general"
]

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

@available(macOS 26.0, *)
@Generable(description: "Pairwise disambiguation between deep_dive and clarification.")
private struct DeepDiveClarificationEnvelope: IntentLabelEnvelope {
    @Guide(description: "Intent label for deep-dive versus clarification disambiguation.", .anyOf([
        "deep_dive",
        "clarification"
    ]))
    var intent: String

    @Guide(description: "Confidence from 0 to 1.")
    var confidence: Double
}

@available(macOS 26.0, *)
@Generable(description: "Pairwise disambiguation between example_request and deep_dive.")
private struct ExampleRequestDeepDiveEnvelope: IntentLabelEnvelope {
    @Guide(description: "Intent label for example-request versus deep-dive disambiguation.", .anyOf([
        "example_request",
        "deep_dive"
    ]))
    var intent: String

    @Guide(description: "Confidence from 0 to 1.")
    var confidence: Double
}

private enum PairwiseIntentTrack {
    case deepDiveClarification
    case exampleRequestDeepDive
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
    case modelNotReady(String)
    case unsupportedLocale(String)
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
        case .modelNotReady:
            return "model_not_ready"
        case .unsupportedLocale:
            return "unsupported_locale"
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
             let .modelNotReady(message),
             let .unsupportedLocale(message),
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
        let fallback = "{\"requestId\":null,\"ok\":false,\"errorType\":\"unknown\",\"message\":\"Failed to encode helper response\"}\n"
        FileHandle.standardOutput.write(Data(fallback.utf8))
    }
}

private func validateIntentRequest(_ request: IntentRequest) throws {
    guard request.version == 1 else {
        throw HelperError.invalidRequest("Unsupported request version")
    }
    guard request.promptVersion == helperSupportedPromptVersion else {
        throw HelperError.invalidRequest("Unsupported promptVersion: \(request.promptVersion)")
    }
    guard request.schemaVersion == helperSupportedSchemaVersion else {
        throw HelperError.invalidRequest("Unsupported schemaVersion: \(request.schemaVersion)")
    }
    guard !request.candidateIntents.isEmpty else {
        throw HelperError.invalidRequest("candidateIntents must be non-empty")
    }
    let candidateSet = Set(request.candidateIntents)
    guard candidateSet == helperSupportedIntents else {
        throw HelperError.invalidRequest("candidateIntents do not match supported helper schema")
    }
}

private func parseRequestFromData(_ data: Data) throws -> IntentRequest {
    guard !data.isEmpty else {
        throw HelperError.invalidRequest("Empty request payload")
    }
    let decoder = JSONDecoder()
    let request = try decoder.decode(IntentRequest.self, from: data)
    try validateIntentRequest(request)
    return request
}

private func parseRequest() throws -> IntentRequest {
    let data = try FileHandle.standardInput.readToEnd() ?? Data()
    return try parseRequestFromData(data)
}

private func isPersistentFoundationModeEnabled() -> Bool {
    let v = ProcessInfo.processInfo.environment["NATIVELY_FOUNDATION_PERSISTENT"]?.lowercased() ?? ""
    return v == "1" || v == "true" || v == "yes"
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
private func ensureModelPreflight(_ model: SystemLanguageModel, locale: Locale?) throws {
    if let locale, !model.supportsLocale(locale) {
        throw HelperError.unsupportedLocale("Model does not support locale: \(locale.identifier)")
    }

    switch model.availability {
    case .available:
        break
    case .unavailable(let reason):
        switch reason {
        case .modelNotReady:
            throw HelperError.modelNotReady("Model unavailable: \(String(describing: reason))")
        case .deviceNotEligible, .appleIntelligenceNotEnabled:
            throw HelperError.unavailable("Model unavailable: \(String(describing: reason))")
        @unknown default:
            let message = availabilityErrorMessage(model.availability)
            throw HelperError.unavailable(message.isEmpty ? "System language model unavailable" : message)
        }
    }
}

private func parseRequestedLocale(_ request: IntentRequest) -> Locale? {
    guard let raw = request.locale?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
        return Locale.current
    }
    return Locale(identifier: raw)
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
        .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

private let codingCuePhrases = [
    "implement",
    "write code",
    "debug",
    "algorithm",
    "lru",
    "typescript",
    "javascript",
    "api payload",
    "handler code",
    "function",
    "refactor",
    "snippet"
]

private let deepDiveCuePhrases = [
    "tradeoff",
    "trade off",
    "why would you choose",
    "why choose",
    "why not",
    "compare",
    "consistency",
    "availability",
    "latency",
    "freshness",
    "throughput"
]

private let clarificationCuePhrases = [
    "clarify",
    "what do you mean",
    "can you explain",
    "unpack",
    "break down",
    "when you say",
    "when you said",
    "what behavior should i expect",
    "what behavior should we expect",
    "what should i expect",
    "what exactly do you mean",
    "what exactly is"
]

private let followUpCuePhrases = [
    "what happened next",
    "then what",
    "after that",
    "what did you do next",
    "what was your next step",
    "what was your next move"
]

private let summaryProbeCuePhrases = [
    "so you are saying",
    "so you re saying",
    "let me make sure",
    "to summarize",
    "so to summarize",
    "if i understood correctly",
    "correct me if i am wrong",
    "correct me if i m wrong",
    "am i right",
    "just to confirm",
    "do i have this right",
    "to confirm"
]

private let exampleRequestCuePhrases = [
    "concrete example",
    "specific example",
    "for example",
    "for instance",
    "scenario where",
    "one scenario",
    "specific instance",
    "concrete instance",
    "concrete case",
    "specific case",
    "tangible example",
    "clear example",
    "real example",
    "practical example",
    "real incident",
    "one concrete",
    "one specific"
]

private func containsAnyPhrase(_ normalizedQuestion: String, phrases: [String]) -> Bool {
    phrases.contains { normalizedQuestion.contains($0) }
}

private func hasCodingCue(_ normalizedQuestion: String) -> Bool {
    containsAnyPhrase(normalizedQuestion, phrases: codingCuePhrases)
}

private func hasDeepDiveCue(_ normalizedQuestion: String) -> Bool {
    containsAnyPhrase(normalizedQuestion, phrases: deepDiveCuePhrases)
}

private func hasClarificationCue(_ normalizedQuestion: String) -> Bool {
    containsAnyPhrase(normalizedQuestion, phrases: clarificationCuePhrases)
}

private func hasFollowUpCue(_ normalizedQuestion: String) -> Bool {
    containsAnyPhrase(normalizedQuestion, phrases: followUpCuePhrases)
}

private func hasSummaryProbeCue(_ normalizedQuestion: String) -> Bool {
    containsAnyPhrase(normalizedQuestion, phrases: summaryProbeCuePhrases)
}

private func hasExampleRequestCue(_ normalizedQuestion: String) -> Bool {
    containsAnyPhrase(normalizedQuestion, phrases: exampleRequestCuePhrases)
}

private func boundedConfidence(_ value: Double) -> Double {
    max(0.0, min(1.0, value))
}

private func reconcileIntentWithCues(request: IntentRequest, modelResult: IntentEnvelope) -> IntentEnvelope {
    let lowered = normalizeQuestion(request.question)
    let hasCoding = hasCodingCue(lowered)
    let hasDeepDive = hasDeepDiveCue(lowered)
    let hasClarification = hasClarificationCue(lowered)
    let hasFollowUp = hasFollowUpCue(lowered)
    let hasSummary = hasSummaryProbeCue(lowered)
    let hasExample = hasExampleRequestCue(lowered)
    let noPriorContext = request.assistantResponseCount == 0

    var intent = modelResult.intent
    var confidence = boundedConfidence(modelResult.confidence)

    if intent == "follow_up" {
        if hasSummary && !hasFollowUp {
            intent = "summary_probe"
            confidence = max(confidence, 0.64)
        } else if hasClarification && !hasFollowUp {
            intent = "clarification"
            confidence = max(confidence, 0.63)
        } else if hasExample && !hasFollowUp {
            intent = "example_request"
            confidence = max(confidence, 0.63)
        } else if noPriorContext && hasDeepDive {
            intent = "deep_dive"
            confidence = max(confidence, 0.63)
        }
    }

    if intent == "general" {
        if hasSummary {
            intent = "summary_probe"
            confidence = max(confidence, 0.6)
        } else if hasClarification {
            intent = "clarification"
            confidence = max(confidence, 0.6)
        } else if hasExample && !hasCoding {
            intent = "example_request"
            confidence = max(confidence, 0.6)
        } else if hasDeepDive && !hasCoding {
            intent = "deep_dive"
            confidence = max(confidence, 0.6)
        }
    }

    if intent == "coding" && hasDeepDive && !hasCoding {
        intent = "deep_dive"
        confidence = max(confidence, 0.62)
    }

    if intent == "deep_dive" && hasExample && !hasCoding {
        intent = "example_request"
        confidence = min(max(confidence, 0.6), 0.82)
    }

    if intent == "deep_dive" && hasClarification && !hasDeepDive {
        intent = "clarification"
        confidence = min(max(confidence, 0.6), 0.82)
    }

    return IntentEnvelope(intent: intent, confidence: boundedConfidence(confidence))
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

    if hasCodingCue(lowered) {
        return .coding
    }

    let contextualCue = hasFollowUpCue(lowered)
        || hasClarificationCue(lowered)
        || hasSummaryProbeCue(lowered)
        || hasExampleRequestCue(lowered)
        || hasDeepDiveCue(lowered)

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

    let hasCoding = hasCodingCue(lowered)
    let hasSummary = hasSummaryProbeCue(lowered)
    let hasFollowUp = hasFollowUpCue(lowered)
    let hasClarification = hasClarificationCue(lowered)
    let hasExample = hasExampleRequestCue(lowered)
    let hasDeepDive = hasDeepDiveCue(lowered)

    if hasCoding && !hasClarification && !hasSummary {
        return "coding"
    }

    if hasSummary {
        return "summary_probe"
    }

    if hasFollowUp {
        return "follow_up"
    }

    if hasClarification {
        return "clarification"
    }

    if hasExample {
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

    if hasDeepDive {
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
    var confidence = boundedConfidence(baseConfidence)
    let likelyIntent = inferLikelyIntent(question: request.question, assistantResponseCount: request.assistantResponseCount)
    let hasCoding = hasCodingCue(lowered)
    let hasDeepDive = hasDeepDiveCue(lowered)
    let hasClarification = hasClarificationCue(lowered)
    let hasFollowUp = hasFollowUpCue(lowered)
    let hasSummary = hasSummaryProbeCue(lowered)
    let hasExample = hasExampleRequestCue(lowered)

    if let likelyIntent, likelyIntent != predictedIntent {
        confidence = min(confidence, 0.58)
    }

    if request.assistantResponseCount == 0 && (predictedIntent == "follow_up" || predictedIntent == "summary_probe") {
        confidence = min(confidence, 0.45)
    }

    if predictedIntent == "follow_up" {
        if hasSummary || hasExample || hasClarification {
            confidence = min(confidence, 0.52)
        }
    }

    if predictedIntent == "deep_dive" {
        if hasClarification && !hasDeepDive {
            confidence = min(confidence, 0.52)
        }
    }

    if predictedIntent == "coding" {
        if hasDeepDive && !hasCoding {
            confidence = min(confidence, 0.55)
        }
    }

    if predictedIntent == "behavioral" {
        let hasContextualCue = hasFollowUp
            || hasSummary
            || hasClarification
            || hasDeepDive
        if hasContextualCue {
            confidence = min(confidence, 0.5)
        }
    }

    if predictedIntent == "example_request" {
        if !hasExample && hasDeepDive {
            confidence = min(confidence, 0.56)
        }
    }

    if predictedIntent == "general" {
        let hasStrongCue = likelyIntent != nil
        if hasStrongCue {
            confidence = min(confidence, 0.55)
        }
    }

    return boundedConfidence(confidence)
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
private func shouldRunPairwiseTrack(for request: IntentRequest, track: PairwiseIntentTrack) -> Bool {
    let lowered = normalizeQuestion(request.question)
    switch track {
    case .deepDiveClarification:
        return hasClarificationCue(lowered)
            || hasDeepDiveCue(lowered)
    case .exampleRequestDeepDive:
        return hasExampleRequestCue(lowered)
            || hasDeepDiveCue(lowered)
    }
}

private func trackContainsIntent(_ track: PairwiseIntentTrack, intent: String) -> Bool {
    switch track {
    case .deepDiveClarification:
        return intent == "deep_dive" || intent == "clarification"
    case .exampleRequestDeepDive:
        return intent == "example_request" || intent == "deep_dive"
    }
}

private func shouldApplyPairwiseOverride(
    baseResult: IntentEnvelope,
    candidate: IntentEnvelope,
    likelyIntent: String?
) -> Bool {
    let baseConfidence = boundedConfidence(baseResult.confidence)
    let candidateConfidence = boundedConfidence(candidate.confidence)

    if candidateConfidence < 0.62 {
        return false
    }

    if candidate.intent == baseResult.intent {
        return candidateConfidence > baseConfidence + 0.03
    }

    if let likelyIntent, candidate.intent == likelyIntent {
        return candidateConfidence >= 0.6
    }

    return candidateConfidence >= baseConfidence + 0.07
}

@available(macOS 26.0, *)
private func buildPairwisePrompt(_ request: IntentRequest, track: PairwiseIntentTrack) -> Prompt {
    let recentDialogue = request.preparedTranscript.trimmingCharacters(in: .whitespacesAndNewlines)

    switch track {
    case .deepDiveClarification:
        return Prompt("""
        Choose one label only: deep_dive or clarification.

        deep_dive: asks for reasoning, tradeoffs, or deeper explanation of architecture/technical decisions.
        clarification: asks to clarify wording or meaning of something already said.

        If question asks "what do you mean" or "clarify", prefer clarification unless the main ask is explicit tradeoff reasoning.
        If question asks tradeoffs between technical factors, prefer deep_dive.

        Current interviewer turn:
        \(request.question)

        Recent dialogue:
        \(recentDialogue.isEmpty ? "[none]" : recentDialogue)
        """)
    case .exampleRequestDeepDive:
        return Prompt("""
        Choose one label only: example_request or deep_dive.

        example_request: asks for one concrete instance, scenario, or real example.
        deep_dive: asks for explanation or reasoning about tradeoffs in general.

        If wording asks for one specific/concrete instance, prefer example_request even when tradeoff words are present.

        Current interviewer turn:
        \(request.question)

        Recent dialogue:
        \(recentDialogue.isEmpty ? "[none]" : recentDialogue)
        """)
    }
}

@available(macOS 26.0, *)
private func runPairwiseTrack(
    request: IntentRequest,
    session: LanguageModelSession,
    track: PairwiseIntentTrack
) async throws -> IntentEnvelope {
    switch track {
    case .deepDiveClarification:
        let response = try await session.respond(
            generating: DeepDiveClarificationEnvelope.self,
            includeSchemaInPrompt: true,
            options: GenerationOptions(temperature: 0),
            prompt: {
                buildPairwisePrompt(request, track: track)
            }
        )
        return IntentEnvelope(intent: response.content.intent, confidence: response.content.confidence)
    case .exampleRequestDeepDive:
        let response = try await session.respond(
            generating: ExampleRequestDeepDiveEnvelope.self,
            includeSchemaInPrompt: true,
            options: GenerationOptions(temperature: 0),
            prompt: {
                buildPairwisePrompt(request, track: track)
            }
        )
        return IntentEnvelope(intent: response.content.intent, confidence: response.content.confidence)
    }
}

@available(macOS 26.0, *)
private func runPairwiseDisambiguation(
    request: IntentRequest,
    session: LanguageModelSession,
    baseResult: IntentEnvelope
) async throws -> IntentEnvelope {
    var resolved = baseResult
    let likelyIntent = inferLikelyIntent(question: request.question, assistantResponseCount: request.assistantResponseCount)
    let lowConfidence = boundedConfidence(baseResult.confidence) <= 0.72

    var tracks: [PairwiseIntentTrack] = []
    switch likelyIntent {
    case "example_request":
        tracks = [.exampleRequestDeepDive]
    case "clarification":
        tracks = [.deepDiveClarification]
    case "deep_dive":
        tracks = [.deepDiveClarification, .exampleRequestDeepDive]
    default:
        if lowConfidence {
            tracks = [.deepDiveClarification, .exampleRequestDeepDive]
        }
    }

    if tracks.isEmpty {
        return resolved
    }

    for track in tracks {
        let isTrackRelevant = lowConfidence
            || trackContainsIntent(track, intent: resolved.intent)
            || (likelyIntent.map { trackContainsIntent(track, intent: $0) } ?? false)
        if !isTrackRelevant {
            continue
        }

        if !shouldRunPairwiseTrack(for: request, track: track) {
            continue
        }

        let candidate = try await runPairwiseTrack(request: request, session: session, track: track)
        if shouldApplyPairwiseOverride(baseResult: resolved, candidate: candidate, likelyIntent: likelyIntent) {
            resolved = candidate
        }

        if boundedConfidence(resolved.confidence) >= 0.74 {
            break
        }
    }

    return resolved
}

@available(macOS 26.0, *)
private func classifyIntent(_ request: IntentRequest) async throws -> IntentEnvelope {
    let model = SystemLanguageModel(useCase: .general)
    try ensureModelPreflight(model, locale: parseRequestedLocale(request))

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
        let base = try await classifyProfile(
            request: request,
            session: session,
            envelope: BehavioralIntentEnvelope.self,
            profile: selectedProfile
        )
        let pairwise = try await runPairwiseDisambiguation(request: request, session: session, baseResult: base)
        return reconcileIntentWithCues(request: request, modelResult: pairwise)
    case .coding:
        let base = try await classifyProfile(
            request: request,
            session: session,
            envelope: CodingIntentEnvelope.self,
            profile: selectedProfile
        )
        let pairwise = try await runPairwiseDisambiguation(request: request, session: session, baseResult: base)
        return reconcileIntentWithCues(request: request, modelResult: pairwise)
    case .contextual:
        let base = try await classifyProfile(
            request: request,
            session: session,
            envelope: ContextualIntentEnvelope.self,
            profile: selectedProfile
        )
        let pairwise = try await runPairwiseDisambiguation(request: request, session: session, baseResult: base)
        return reconcileIntentWithCues(request: request, modelResult: pairwise)
    case .general:
        let base = try await classifyProfile(
            request: request,
            session: session,
            envelope: GeneralIntentEnvelope.self,
            profile: selectedProfile
        )
        let pairwise = try await runPairwiseDisambiguation(request: request, session: session, baseResult: base)
        return reconcileIntentWithCues(request: request, modelResult: pairwise)
    }
}

@available(macOS 26.0, *)
private func runSingleIntent(request: IntentRequest) async {
    do {
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
                requestId: request.requestId,
                intent: result.intent,
                confidence: normalizedConfidence,
                promptVersion: request.promptVersion,
                schemaVersion: request.schemaVersion
            )
        )
    } catch let error as HelperError {
        writeResponse(.failure(requestId: request.requestId, errorType: error.type, message: error.message))
    } catch {
        writeResponse(.failure(requestId: request.requestId, errorType: "unknown", message: String(describing: error)))
    }
}

@available(macOS 26.0, *)
private func runHelper() async {
    do {
        let request = try parseRequest()
        await runSingleIntent(request: request)
    } catch let error as HelperError {
        writeResponse(.failure(requestId: nil, errorType: error.type, message: error.message))
    } catch {
        writeResponse(.failure(requestId: nil, errorType: "unknown", message: String(describing: error)))
    }
}

@available(macOS 26.0, *)
private func runPersistentLoop() async {
    while let line = readLine() {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { continue }
        if trimmed.contains("\"type\""), trimmed.lowercased().contains("cancel") {
            continue
        }
        guard let data = trimmed.data(using: .utf8) else { continue }
        var requestIdForError: String?
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            requestIdForError = obj["requestId"] as? String
        }
        do {
            let request = try parseRequestFromData(data)
            await runSingleIntent(request: request)
        } catch let error as HelperError {
            writeResponse(.failure(requestId: requestIdForError, errorType: error.type, message: error.message))
        } catch {
            writeResponse(.failure(requestId: requestIdForError, errorType: "unknown", message: String(describing: error)))
        }
    }
}

@main
struct FoundationIntentHelperMain {
    static func main() async {
        if #available(macOS 26.0, *) {
            if isPersistentFoundationModeEnabled() {
                await runPersistentLoop()
            } else {
                await runHelper()
            }
        } else {
            writeResponse(.failure(requestId: nil, errorType: "unavailable", message: "Foundation Models intent helper requires macOS 26+"))
        }
    }
}
