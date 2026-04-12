import Foundation

extension NSLock {
    @discardableResult
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}

public enum Layer3Time {
    private static let formatter: ISO8601DateFormatter = {
        ISO8601DateFormatter()
    }()

    public static func timestamp() -> String {
        formatter.string(from: Date())
    }
}
