import Foundation

enum ConnectionPolicy {
    static func endpoint(_ text: String, allowLocal: Bool) throws -> URL {
        guard let parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let url = parts.url, let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else {
            throw ConnectionError.invalid
        }
        let normalized = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let loopback = normalized == "localhost" || normalized.hasSuffix(".localhost") || normalized.hasPrefix("127.") || normalized == "::1" || normalized.hasPrefix("::ffff:127.")
        if loopback {
            guard allowLocal && host == "127.0.0.1" && parts.scheme == "http" else { throw ConnectionError.local }
        } else if parts.scheme != "https" { throw ConnectionError.tls }
        return url
    }
}
enum ConnectionError: LocalizedError {
    case invalid, local, tls
    var errorDescription: String? {
        switch self {
        case .invalid: return "Enter a server origin without a path, credentials, query, or fragment."
        case .local: return "iOS connects only to a remote server. Desktop local access uses http://127.0.0.1:PORT."
        case .tls: return "Remote connections require HTTPS with a valid certificate."
        }
    }
}
