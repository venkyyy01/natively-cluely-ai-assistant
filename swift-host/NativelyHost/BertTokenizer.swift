// swift-host/NativelyHost/BertTokenizer.swift

import Foundation

/// BERT WordPiece tokenizer for MiniLM embedding model.
/// Handles vocabulary loading, text preprocessing, and WordPiece tokenization.
class BertTokenizer {
    
    // MARK: - Constants
    
    private static let maxSequenceLength = 512
    private static let unknownToken = "[UNK]"
    private static let clsToken = "[CLS]"
    private static let sepToken = "[SEP]"
    private static let padToken = "[PAD]"
    private static let continuationPrefix = "##"
    
    // MARK: - Properties
    
    private var vocab: [String: Int] = [:]
    private var reverseVocab: [Int: String] = [:]
    private let vocabLoaded: Bool
    
    /// Special token IDs
    let unknownTokenId: Int
    let clsTokenId: Int
    let sepTokenId: Int
    let padTokenId: Int
    
    // MARK: - Initialization
    
    /// Initialize with vocabulary file path
    init(vocabPath: URL) throws {
        let vocabContent = try String(contentsOf: vocabPath, encoding: .utf8)
        let lines = vocabContent.components(separatedBy: .newlines)
        
        for (index, token) in lines.enumerated() {
            let trimmed = token.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty {
                vocab[trimmed] = index
                reverseVocab[index] = trimmed
            }
        }
        
        vocabLoaded = !vocab.isEmpty
        
        // Set special token IDs
        unknownTokenId = vocab[Self.unknownToken] ?? 100
        clsTokenId = vocab[Self.clsToken] ?? 101
        sepTokenId = vocab[Self.sepToken] ?? 102
        padTokenId = vocab[Self.padToken] ?? 0
        
        print("BertTokenizer: Loaded \(vocab.count) vocabulary entries")
    }
    
    /// Initialize with mock vocabulary for development mode
    init() {
        vocabLoaded = false
        
        // Mock special token IDs (standard BERT vocabulary positions)
        padTokenId = 0
        unknownTokenId = 100
        clsTokenId = 101
        sepTokenId = 102
        
        print("BertTokenizer: Initialized in mock mode (no vocabulary loaded)")
    }
    
    // MARK: - Public Interface
    
    /// Tokenize text into token IDs with attention mask
    func tokenize(_ text: String) -> (ids: [Int64], attentionMask: [Int64]) {
        guard vocabLoaded else {
            return mockTokenize(text)
        }
        
        // Preprocess text
        let processed = preprocess(text)
        
        // Split into words
        let words = splitOnPunctuation(processed)
        
        // Apply WordPiece tokenization
        var tokens: [Int] = [clsTokenId]
        
        for word in words {
            let wordTokens = wordPieceTokenize(word)
            tokens.append(contentsOf: wordTokens)
            
            // Respect max sequence length (reserve 1 for [SEP])
            if tokens.count >= Self.maxSequenceLength - 1 {
                tokens = Array(tokens.prefix(Self.maxSequenceLength - 1))
                break
            }
        }
        
        tokens.append(sepTokenId)
        
        // Create attention mask (1 for real tokens, 0 for padding)
        let attentionMask = [Int64](repeating: 1, count: tokens.count)
        
        return (tokens.map { Int64($0) }, attentionMask)
    }
    
    /// Decode token IDs back to text
    func decode(_ ids: [Int]) -> String {
        guard vocabLoaded else {
            return "[mock decoded text]"
        }
        
        var result: [String] = []
        
        for id in ids {
            // Skip special tokens
            if id == clsTokenId || id == sepTokenId || id == padTokenId {
                continue
            }
            
            if let token = reverseVocab[id] {
                if token.hasPrefix(Self.continuationPrefix) {
                    // Remove ## prefix and append to previous token
                    let stripped = String(token.dropFirst(2))
                    if !result.isEmpty {
                        result[result.count - 1] += stripped
                    } else {
                        result.append(stripped)
                    }
                } else {
                    result.append(token)
                }
            } else {
                result.append(Self.unknownToken)
            }
        }
        
        return result.joined(separator: " ")
    }
    
    // MARK: - Text Preprocessing
    
    private func preprocess(_ text: String) -> String {
        var result = text.lowercased()
        
        // Strip accents (NFD normalization + remove combining marks)
        result = result.decomposedStringWithCanonicalMapping
        result = result.unicodeScalars
            .filter { !CharacterSet(charactersIn: "\u{0300}"..."\u{036F}").contains($0) }
            .map { String($0) }
            .joined()
        
        // Normalize whitespace
        result = result.components(separatedBy: .whitespaces)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        
        return result
    }
    
    private func splitOnPunctuation(_ text: String) -> [String] {
        var result: [String] = []
        var currentWord = ""
        
        let punctuation = CharacterSet.punctuationCharacters
            .union(CharacterSet(charactersIn: "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"))
        
        for scalar in text.unicodeScalars {
            let char = String(scalar)
            
            if punctuation.contains(scalar) {
                // Flush current word
                if !currentWord.isEmpty {
                    result.append(currentWord)
                    currentWord = ""
                }
                // Add punctuation as separate token
                result.append(char)
            } else if CharacterSet.whitespaces.contains(scalar) {
                // Flush current word
                if !currentWord.isEmpty {
                    result.append(currentWord)
                    currentWord = ""
                }
            } else {
                currentWord += char
            }
        }
        
        // Flush final word
        if !currentWord.isEmpty {
            result.append(currentWord)
        }
        
        return result
    }
    
    // MARK: - WordPiece Tokenization
    
    private func wordPieceTokenize(_ word: String) -> [Int] {
        guard !word.isEmpty else { return [] }
        
        var tokens: [Int] = []
        var start = word.startIndex
        
        while start < word.endIndex {
            var end = word.endIndex
            var found = false
            
            while start < end {
                let substring: String
                if start == word.startIndex {
                    substring = String(word[start..<end])
                } else {
                    substring = Self.continuationPrefix + String(word[start..<end])
                }
                
                if let tokenId = vocab[substring] {
                    tokens.append(tokenId)
                    found = true
                    start = end
                    break
                }
                
                // Try shorter substring
                end = word.index(before: end)
            }
            
            if !found {
                // Character not in vocabulary, use [UNK]
                tokens.append(unknownTokenId)
                start = word.index(after: start)
            }
        }
        
        return tokens
    }
    
    // MARK: - Mock Mode
    
    /// Generate mock token IDs for development without vocabulary file
    private func mockTokenize(_ text: String) -> (ids: [Int64], attentionMask: [Int64]) {
        // Simple mock: hash each word to generate consistent token IDs
        let words = text.lowercased()
            .components(separatedBy: .whitespaces)
            .filter { !$0.isEmpty }
        
        var tokens: [Int64] = [Int64(clsTokenId)]
        
        for word in words {
            // Generate a deterministic "token ID" from the word
            let hash = abs(word.hashValue) % 28000 + 1000
            tokens.append(Int64(hash))
            
            if tokens.count >= Self.maxSequenceLength - 1 {
                break
            }
        }
        
        tokens.append(Int64(sepTokenId))
        
        let attentionMask = [Int64](repeating: 1, count: tokens.count)
        
        return (tokens, attentionMask)
    }
}

// MARK: - Tokenizer Result Extension

extension BertTokenizer {
    /// Tokenize and pad to a specific length
    func tokenizeAndPad(_ text: String, to length: Int) -> (ids: [Int64], attentionMask: [Int64]) {
        var (ids, mask) = tokenize(text)
        
        // Truncate if too long
        if ids.count > length {
            ids = Array(ids.prefix(length - 1)) + [Int64(sepTokenId)]
            mask = Array(mask.prefix(length))
        }
        
        // Pad if too short
        while ids.count < length {
            ids.append(Int64(padTokenId))
            mask.append(0)
        }
        
        return (ids, mask)
    }
}
