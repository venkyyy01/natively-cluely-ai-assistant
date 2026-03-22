// swift-host/NativelyHost/ANEEmbeddingService.swift

import Foundation
import CoreML

/// ANE-accelerated embedding service using ONNX model via CoreML.
/// Generates text embeddings using MiniLM-L6-v2 with Neural Engine acceleration.
/// Falls back to mock embeddings in development mode when model files are unavailable.
class ANEEmbeddingService {
    
    // MARK: - Constants
    
    private static let embeddingDimension = 384  // MiniLM-L6-v2 output dimension
    private static let maxSequenceLength = 128   // Typical max for embedding models
    
    // MARK: - Properties
    
    private let tokenizer: BertTokenizer
    private var model: MLModel?
    private let isModelLoaded: Bool
    private let modelLoadError: Error?
    
    // MARK: - Initialization
    
    /// Initialize the embedding service, loading model and vocabulary
    init() {
        var loadedTokenizer: BertTokenizer
        var loadedModel: MLModel? = nil
        var modelError: Error? = nil
        var modelLoaded = false
        
        // Try to load vocabulary
        if let vocabURL = Self.findVocabFile() {
            do {
                loadedTokenizer = try BertTokenizer(vocabPath: vocabURL)
                print("ANEEmbeddingService: Vocabulary loaded from \(vocabURL.path)")
            } catch {
                print("ANEEmbeddingService: Failed to load vocabulary: \(error)")
                loadedTokenizer = BertTokenizer()
            }
        } else {
            print("ANEEmbeddingService: No vocabulary file found, using mock tokenizer")
            loadedTokenizer = BertTokenizer()
        }
        
        // Try to load CoreML model
        if let modelURL = Self.findModelFile() {
            do {
                let config = MLModelConfiguration()
                
                // Prefer Neural Engine for M-series acceleration (macOS 13+)
                if #available(macOS 13.0, *) {
                    config.computeUnits = .cpuAndNeuralEngine
                } else {
                    config.computeUnits = .all
                }
                
                loadedModel = try MLModel(contentsOf: modelURL, configuration: config)
                modelLoaded = true
                print("ANEEmbeddingService: Model loaded from \(modelURL.path)")
            } catch {
                modelError = error
                print("ANEEmbeddingService: Failed to load model: \(error)")
            }
        } else {
            print("ANEEmbeddingService: No model file found, using mock embeddings")
        }
        
        self.tokenizer = loadedTokenizer
        self.model = loadedModel
        self.isModelLoaded = modelLoaded
        self.modelLoadError = modelError
    }
    
    // MARK: - Model File Discovery
    
    private static func findVocabFile() -> URL? {
        // Check bundle resources
        if let bundlePath = Bundle.main.url(forResource: "vocab", withExtension: "txt", subdirectory: "models") {
            return bundlePath
        }
        
        // Check Resources/models directory relative to bundle
        if let bundlePath = Bundle.main.resourceURL?.appendingPathComponent("models/vocab.txt") {
            if FileManager.default.fileExists(atPath: bundlePath.path) {
                return bundlePath
            }
        }
        
        // Development: check relative paths
        let devPaths = [
            "NativelyHost/Resources/models/vocab.txt",
            "Resources/models/vocab.txt",
            "../Resources/models/vocab.txt"
        ]
        
        for path in devPaths {
            if FileManager.default.fileExists(atPath: path) {
                return URL(fileURLWithPath: path)
            }
        }
        
        return nil
    }
    
    private static func findModelFile() -> URL? {
        // Check for compiled CoreML model (.mlmodelc) first
        if let bundlePath = Bundle.main.url(forResource: "minilm-l6-v2", withExtension: "mlmodelc", subdirectory: "models") {
            return bundlePath
        }
        
        // Check for .mlpackage
        if let bundlePath = Bundle.main.url(forResource: "minilm-l6-v2", withExtension: "mlpackage", subdirectory: "models") {
            return bundlePath
        }
        
        // Check Resources/models directory
        if let bundlePath = Bundle.main.resourceURL?.appendingPathComponent("models/minilm-l6-v2.mlmodelc") {
            if FileManager.default.fileExists(atPath: bundlePath.path) {
                return bundlePath
            }
        }
        
        // Development paths
        let devPaths = [
            "NativelyHost/Resources/models/minilm-l6-v2.mlmodelc",
            "Resources/models/minilm-l6-v2.mlmodelc"
        ]
        
        for path in devPaths {
            if FileManager.default.fileExists(atPath: path) {
                return URL(fileURLWithPath: path)
            }
        }
        
        return nil
    }
    
    // MARK: - Public Interface
    
    /// Generate embedding for a single text
    /// - Parameter text: Input text to embed
    /// - Returns: Embedding vector of dimension 384
    func embed(_ text: String) async throws -> [Float] {
        let startTime = CFAbsoluteTimeGetCurrent()
        
        let embedding: [Float]
        
        if isModelLoaded, let model = model {
            embedding = try await generateRealEmbedding(text, model: model)
        } else {
            embedding = generateMockEmbedding(text)
        }
        
        let latencyMs = (CFAbsoluteTimeGetCurrent() - startTime) * 1000
        print("ANEEmbeddingService: Generated embedding in \(String(format: "%.2f", latencyMs))ms")
        
        return embedding
    }
    
    /// Generate embeddings for multiple texts in batch
    /// - Parameter texts: Array of input texts
    /// - Returns: Array of embedding vectors
    func embedBatch(_ texts: [String]) async throws -> [[Float]] {
        let startTime = CFAbsoluteTimeGetCurrent()
        
        // Process in parallel using task group
        let embeddings = try await withThrowingTaskGroup(of: (Int, [Float]).self) { group in
            for (index, text) in texts.enumerated() {
                group.addTask {
                    let embedding = try await self.embed(text)
                    return (index, embedding)
                }
            }
            
            var results = [[Float]](repeating: [], count: texts.count)
            for try await (index, embedding) in group {
                results[index] = embedding
            }
            return results
        }
        
        let latencyMs = (CFAbsoluteTimeGetCurrent() - startTime) * 1000
        print("ANEEmbeddingService: Generated \(texts.count) embeddings in \(String(format: "%.2f", latencyMs))ms")
        
        return embeddings
    }
    
    /// Check if the service has a real model loaded
    var hasRealModel: Bool {
        return isModelLoaded
    }
    
    /// Get the embedding dimension
    var dimension: Int {
        return Self.embeddingDimension
    }
    
    // MARK: - Real Embedding Generation
    
    private func generateRealEmbedding(_ text: String, model: MLModel) async throws -> [Float] {
        // Tokenize input
        let (tokenIds, attentionMask) = tokenizer.tokenizeAndPad(text, to: Self.maxSequenceLength)
        
        // Create MLMultiArray inputs
        let inputIdsArray = try MLMultiArray(shape: [1, NSNumber(value: Self.maxSequenceLength)], dataType: .int32)
        let attentionMaskArray = try MLMultiArray(shape: [1, NSNumber(value: Self.maxSequenceLength)], dataType: .int32)
        
        for i in 0..<Self.maxSequenceLength {
            inputIdsArray[i] = NSNumber(value: Int32(tokenIds[i]))
            attentionMaskArray[i] = NSNumber(value: Int32(attentionMask[i]))
        }
        
        // Create feature provider
        let inputFeatures = EmbeddingModelInput(
            input_ids: inputIdsArray,
            attention_mask: attentionMaskArray
        )
        
        // Run inference
        let output = try await Task.detached(priority: .userInitiated) {
            try model.prediction(from: inputFeatures)
        }.value
        
        // Extract embedding from output
        guard let lastHiddenState = output.featureValue(for: "last_hidden_state")?.multiArrayValue else {
            throw EmbeddingError.invalidOutput
        }
        
        // Mean pooling across sequence dimension
        return meanPool(hiddenState: lastHiddenState, attentionMask: attentionMask)
    }
    
    /// Mean pooling: average hidden states weighted by attention mask
    private func meanPool(hiddenState: MLMultiArray, attentionMask: [Int64]) -> [Float] {
        var pooled = [Float](repeating: 0, count: Self.embeddingDimension)
        var maskSum: Float = 0
        
        let seqLength = min(Self.maxSequenceLength, hiddenState.shape[1].intValue)
        
        for pos in 0..<seqLength {
            let maskValue = Float(attentionMask[pos])
            maskSum += maskValue
            
            for dim in 0..<Self.embeddingDimension {
                let index = pos * Self.embeddingDimension + dim
                let value = hiddenState[index].floatValue
                pooled[dim] += value * maskValue
            }
        }
        
        // Normalize by mask sum
        if maskSum > 0 {
            for i in 0..<Self.embeddingDimension {
                pooled[i] /= maskSum
            }
        }
        
        // L2 normalize the embedding
        return l2Normalize(pooled)
    }
    
    /// L2 normalize a vector
    private func l2Normalize(_ vector: [Float]) -> [Float] {
        let norm = sqrt(vector.reduce(0) { $0 + $1 * $1 })
        guard norm > 0 else { return vector }
        return vector.map { $0 / norm }
    }
    
    // MARK: - Mock Embedding Generation
    
    /// Generate deterministic mock embedding based on text hash
    /// Used in development when model files are not available
    private func generateMockEmbedding(_ text: String) -> [Float] {
        // Use text hash to generate reproducible embedding
        var hasher = Hasher()
        hasher.combine(text.lowercased())
        let seed = abs(hasher.finalize())
        
        // Generate pseudo-random but deterministic embedding
        var embedding = [Float](repeating: 0, count: Self.embeddingDimension)
        
        // Use linear congruential generator with seed
        var lcg = seed
        for i in 0..<Self.embeddingDimension {
            lcg = (lcg &* 1103515245 &+ 12345) & 0x7FFFFFFF
            // Map to [-1, 1] range
            embedding[i] = Float(lcg) / Float(0x7FFFFFFF) * 2.0 - 1.0
        }
        
        // L2 normalize
        return l2Normalize(embedding)
    }
}

// MARK: - Supporting Types

/// Feature provider for embedding model input
private class EmbeddingModelInput: MLFeatureProvider {
    let input_ids: MLMultiArray
    let attention_mask: MLMultiArray
    
    var featureNames: Set<String> {
        return ["input_ids", "attention_mask"]
    }
    
    init(input_ids: MLMultiArray, attention_mask: MLMultiArray) {
        self.input_ids = input_ids
        self.attention_mask = attention_mask
    }
    
    func featureValue(for featureName: String) -> MLFeatureValue? {
        switch featureName {
        case "input_ids":
            return MLFeatureValue(multiArray: input_ids)
        case "attention_mask":
            return MLFeatureValue(multiArray: attention_mask)
        default:
            return nil
        }
    }
}

/// Embedding service errors
enum EmbeddingError: Error, LocalizedError {
    case modelNotLoaded
    case invalidInput
    case invalidOutput
    case tokenizationFailed
    
    var errorDescription: String? {
        switch self {
        case .modelNotLoaded:
            return "Embedding model is not loaded"
        case .invalidInput:
            return "Invalid input for embedding"
        case .invalidOutput:
            return "Model produced invalid output"
        case .tokenizationFailed:
            return "Failed to tokenize input text"
        }
    }
}

// MARK: - Embedding Result

/// Result structure for embedding operations
struct EmbeddingResult {
    let embedding: [Float]
    let latencyMs: Double
    let isMock: Bool
}
