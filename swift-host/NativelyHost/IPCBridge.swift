// swift-host/NativelyHost/IPCBridge.swift

import Foundation

// MARK: - JSON-RPC Types

struct JsonRpcRequest: Codable {
    let jsonrpc: String
    let id: Int?
    let method: String
    let params: [String: AnyCodable]?
    
    init(method: String, params: [String: Any]? = nil, id: Int? = nil) {
        self.jsonrpc = "2.0"
        self.id = id
        self.method = method
        self.params = params?.mapValues { AnyCodable($0) }
    }
}

struct JsonRpcResponse: Codable {
    let jsonrpc: String
    let id: Int?
    let result: AnyCodable?
    let error: JsonRpcError?
}

struct JsonRpcError: Codable {
    let code: Int
    let message: String
}

/// Type-erased Codable wrapper for dynamic JSON values
struct AnyCodable: Codable {
    let value: Any
    
    init(_ value: Any) {
        self.value = value
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        
        if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map { $0.value }
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else {
            value = NSNull()
        }
    }
    
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        
        switch value {
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            try container.encodeNil()
        }
    }
}

// MARK: - IPC Bridge

class IPCBridge {
    private var backendProcess: Process?
    private var stdinPipe: Pipe?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    
    private var pendingRequests: [Int: CheckedContinuation<JsonRpcResponse, Error>] = [:]
    private var nextRequestId = 1
    private let queue = DispatchQueue(label: "com.natively.ipc")
    
    private var readBuffer = Data()
    
    typealias NotificationHandler = ([String: Any]) -> Void
    private var notificationHandlers: [String: NotificationHandler] = [:]
    
    // Embedding service for ANE acceleration
    private var embeddingService: ANEEmbeddingService?
    
    // Request handlers for methods handled by Swift host
    typealias RequestHandler = (JsonRpcRequest) async throws -> Any?
    private var requestHandlers: [String: RequestHandler] = [:]
    
    init() throws {}
    
    // MARK: - Backend Lifecycle
    
    func startBackend() throws {
        let process = Process()
        
        // Find the backend executable and script
        let backendConfig = try findBackendPath()
        
        process.executableURL = URL(fileURLWithPath: backendConfig.executable)
        process.arguments = backendConfig.arguments
        
        // Spoof process identity for stealth
        var env = ProcessInfo.processInfo.environment
        env["__CFBundleIdentifier"] = "com.apple.assistantd"
        // Additional environment for Node.js
        env["NODE_ENV"] = "production"
        process.environment = env
        
        // Set working directory for development mode
        if let workDir = backendConfig.workingDirectory {
            process.currentDirectoryURL = URL(fileURLWithPath: workDir)
        }
        
        // Setup pipes
        stdinPipe = Pipe()
        stdoutPipe = Pipe()
        stderrPipe = Pipe()
        
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        
        // Handle stdout data
        stdoutPipe?.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty {
                self?.handleIncomingData(data)
            }
        }
        
        // Handle stderr (for logging)
        stderrPipe?.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if let str = String(data: data, encoding: .utf8), !str.isEmpty {
                print("[Backend stderr] \(str)")
            }
        }
        
        // Handle process termination
        process.terminationHandler = { [weak self] proc in
            print("IPCBridge: Backend terminated with status: \(proc.terminationStatus)")
            self?.handleBackendTermination()
        }
        
        try process.run()
        backendProcess = process
        
        print("IPCBridge: Backend started (PID: \(process.processIdentifier))")
    }
    
    func stopBackend() {
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        backendProcess?.terminate()
        backendProcess?.waitUntilExit()
        backendProcess = nil
        stdinPipe = nil
        stdoutPipe = nil
        stderrPipe = nil
        print("IPCBridge: Backend stopped")
    }
    
    private func handleBackendTermination() {
        // Clear pending requests
        queue.async { [weak self] in
            for (_, continuation) in self?.pendingRequests ?? [:] {
                continuation.resume(throwing: IPCError.notConnected)
            }
            self?.pendingRequests.removeAll()
        }
        
        // Could implement auto-restart here if desired
    }
    
    // MARK: - Backend Path Resolution
    
    private struct BackendConfig {
        let executable: String
        let arguments: [String]
        let workingDirectory: String?
    }
    
    private func findBackendPath() throws -> BackendConfig {
        // Option 1: Bundled assistantd (renamed node binary with bundled script)
        if let bundledAssistantd = Bundle.main.path(forResource: "assistantd", ofType: nil),
           let bundledScript = Bundle.main.path(forResource: "backend", ofType: "js") {
            return BackendConfig(
                executable: bundledAssistantd,
                arguments: [bundledScript],
                workingDirectory: nil
            )
        }
        
        // Option 2: Development mode - use system node with local backend
        let fileManager = FileManager.default
        
        // Try to find node-backend relative to executable or current directory
        let possiblePaths = [
            // Relative to current working directory
            "node-backend/dist/main.js",
            // Relative to executable
            Bundle.main.bundlePath + "/../../../node-backend/dist/main.js",
            // Absolute development path
            ProcessInfo.processInfo.environment["NATIVELY_BACKEND_PATH"]
        ].compactMap { $0 }
        
        for path in possiblePaths {
            let expandedPath = (path as NSString).expandingTildeInPath
            if fileManager.fileExists(atPath: expandedPath) {
                // Find node executable
                let nodePath = findNodeExecutable()
                guard let node = nodePath else {
                    throw IPCError.backendNotFound
                }
                
                // Get working directory (parent of node-backend)
                let scriptURL = URL(fileURLWithPath: expandedPath)
                let workDir = scriptURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
                
                return BackendConfig(
                    executable: node,
                    arguments: [expandedPath],
                    workingDirectory: fileManager.fileExists(atPath: workDir) ? workDir : nil
                )
            }
        }
        
        throw IPCError.backendNotFound
    }
    
    private func findNodeExecutable() -> String? {
        // Check common node locations
        let possiblePaths = [
            "/usr/local/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/bin/node",
            ProcessInfo.processInfo.environment["NODE_PATH"]
        ].compactMap { $0 }
        
        for path in possiblePaths {
            if FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        }
        
        // Try to find via which
        let whichProcess = Process()
        let pipe = Pipe()
        whichProcess.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        whichProcess.arguments = ["node"]
        whichProcess.standardOutput = pipe
        
        do {
            try whichProcess.run()
            whichProcess.waitUntilExit()
            
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            if let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !path.isEmpty,
               FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        } catch {
            print("IPCBridge: Failed to find node via which: \(error)")
        }
        
        return nil
    }
    
    // MARK: - Message Handling
    
    private func handleIncomingData(_ data: Data) {
        readBuffer.append(data)
        
        // Process complete lines (JSON-RPC messages are newline-delimited)
        while let newlineIndex = readBuffer.firstIndex(of: UInt8(ascii: "\n")) {
            let lineData = readBuffer[..<newlineIndex]
            readBuffer = Data(readBuffer[readBuffer.index(after: newlineIndex)...])
            
            if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
                processMessage(line)
            }
        }
    }
    
    private func processMessage(_ json: String) {
        guard let data = json.data(using: .utf8) else { return }
        
        // Try to decode as response first (responses from backend to our calls)
        if let response = try? JSONDecoder().decode(JsonRpcResponse.self, from: data) {
            handleResponse(response)
            return
        }
        
        // Try to decode as request/notification (from backend to Swift)
        if let request = try? JSONDecoder().decode(JsonRpcRequest.self, from: data) {
            // Check if this is a request (has id) or notification
            if request.id != nil {
                handleIncomingRequest(request)
            } else {
                handleNotification(request)
            }
            return
        }
        
        print("IPCBridge: Unknown message format: \(json)")
    }
    
    private func handleResponse(_ response: JsonRpcResponse) {
        guard let id = response.id else { return }
        
        queue.async { [weak self] in
            if let continuation = self?.pendingRequests.removeValue(forKey: id) {
                continuation.resume(returning: response)
            }
        }
    }
    
    private func handleNotification(_ request: JsonRpcRequest) {
        // First check registered handlers
        if let handler = notificationHandlers[request.method] {
            let params = request.params?.mapValues { $0.value } ?? [:]
            DispatchQueue.main.async {
                handler(params)
            }
        }
        
        // Also post to NotificationCenter for WindowManager to forward to WebView
        let params = request.params?.mapValues { $0.value } ?? [:]
        DispatchQueue.main.async {
            NotificationCenter.default.post(
                name: .backendNotification,
                object: nil,
                userInfo: [
                    "channel": request.method,
                    "data": params
                ]
            )
        }
    }
    
    /// Handle incoming request from backend that Swift host should process
    private func handleIncomingRequest(_ request: JsonRpcRequest) {
        guard let id = request.id else {
            // It's a notification, not a request
            handleNotification(request)
            return
        }
        
        // Check if we have a handler for this method
        if let handler = requestHandlers[request.method] {
            Task {
                do {
                    let result = try await handler(request)
                    sendResponse(id: id, result: result)
                } catch {
                    sendErrorResponse(id: id, code: -32000, message: error.localizedDescription)
                }
            }
        } else {
            // Unknown method - send error
            sendErrorResponse(id: id, code: -32601, message: "Method not found: \(request.method)")
        }
    }
    
    private func sendResponse(id: Int, result: Any?) {
        let response: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "result": result ?? NSNull()
        ]
        
        do {
            let data = try JSONSerialization.data(withJSONObject: response)
            var dataWithNewline = data
            dataWithNewline.append(UInt8(ascii: "\n"))
            stdinPipe?.fileHandleForWriting.write(dataWithNewline)
        } catch {
            print("IPCBridge: Failed to send response: \(error)")
        }
    }
    
    private func sendErrorResponse(id: Int, code: Int, message: String) {
        let response: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "error": [
                "code": code,
                "message": message
            ]
        ]
        
        do {
            let data = try JSONSerialization.data(withJSONObject: response)
            var dataWithNewline = data
            dataWithNewline.append(UInt8(ascii: "\n"))
            stdinPipe?.fileHandleForWriting.write(dataWithNewline)
        } catch {
            print("IPCBridge: Failed to send error response: \(error)")
        }
    }
    
    // MARK: - Public API
    
    /// Send a request and wait for response
    func call(_ method: String, params: [String: Any]? = nil) async throws -> Any? {
        let id = queue.sync { () -> Int in
            let id = nextRequestId
            nextRequestId += 1
            return id
        }
        
        let request = JsonRpcRequest(method: method, params: params, id: id)
        
        let response: JsonRpcResponse = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<JsonRpcResponse, Error>) in
            queue.async { [weak self] in
                self?.pendingRequests[id] = continuation
            }
            
            do {
                try sendMessage(request)
            } catch {
                queue.async { [weak self] in
                    self?.pendingRequests.removeValue(forKey: id)
                }
                continuation.resume(throwing: error)
            }
        }
        
        if response.error != nil {
            throw IPCError.invalidResponse
        }
        
        return response.result?.value
    }
    
    /// Send a notification (no response expected)
    func notify(_ method: String, params: [String: Any]? = nil) throws {
        let request = JsonRpcRequest(method: method, params: params)
        try sendMessage(request)
    }
    
    /// Register a handler for incoming notifications
    func onNotification(_ method: String, handler: @escaping NotificationHandler) {
        notificationHandlers[method] = handler
    }
    
    /// Register a handler for incoming requests (methods Swift should handle)
    func onRequest(_ method: String, handler: @escaping RequestHandler) {
        requestHandlers[method] = handler
    }
    
    // MARK: - Embedding Service
    
    /// Initialize and register the ANE embedding service
    func registerEmbeddingService(_ service: ANEEmbeddingService) {
        self.embeddingService = service
        
        // Register handler for embedding:generate requests
        onRequest("embedding:generate") { [weak self] request in
            return try await self?.handleEmbeddingGenerate(request)
        }
        
        // Register handler for embedding:generateBatch requests
        onRequest("embedding:generateBatch") { [weak self] request in
            return try await self?.handleEmbeddingGenerateBatch(request)
        }
        
        print("IPCBridge: Embedding service registered")
    }
    
    private func handleEmbeddingGenerate(_ request: JsonRpcRequest) async throws -> [String: Any] {
        guard let service = embeddingService else {
            throw IPCError.invalidResponse
        }
        
        guard let params = request.params,
              let text = params["text"]?.value as? String else {
            throw IPCError.invalidResponse
        }
        
        let startTime = CFAbsoluteTimeGetCurrent()
        let embedding = try await service.embed(text)
        let latencyMs = (CFAbsoluteTimeGetCurrent() - startTime) * 1000
        
        return [
            "embedding": embedding.map { Double($0) },
            "latencyMs": latencyMs,
            "dimension": service.dimension,
            "isMock": !service.hasRealModel
        ]
    }
    
    private func handleEmbeddingGenerateBatch(_ request: JsonRpcRequest) async throws -> [String: Any] {
        guard let service = embeddingService else {
            throw IPCError.invalidResponse
        }
        
        guard let params = request.params,
              let texts = params["texts"]?.value as? [String] else {
            throw IPCError.invalidResponse
        }
        
        let startTime = CFAbsoluteTimeGetCurrent()
        let embeddings = try await service.embedBatch(texts)
        let latencyMs = (CFAbsoluteTimeGetCurrent() - startTime) * 1000
        
        return [
            "embeddings": embeddings.map { $0.map { Double($0) } },
            "latencyMs": latencyMs,
            "dimension": service.dimension,
            "count": texts.count,
            "isMock": !service.hasRealModel
        ]
    }
    
    private func sendMessage<T: Encodable>(_ message: T) throws {
        guard let pipe = stdinPipe else {
            throw IPCError.notConnected
        }
        
        let data = try JSONEncoder().encode(message)
        var dataWithNewline = data
        dataWithNewline.append(UInt8(ascii: "\n"))
        
        pipe.fileHandleForWriting.write(dataWithNewline)
    }
}

// MARK: - Errors

enum IPCError: Error {
    case backendNotFound
    case notConnected
    case timeout
    case invalidResponse
}
