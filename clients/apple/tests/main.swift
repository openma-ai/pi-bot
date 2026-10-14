import Foundation

func accepts(_ input: String, local: Bool) -> Bool { (try? ConnectionPolicy.endpoint(input, allowLocal: local)) != nil }
precondition(accepts("http://127.0.0.1:4317", local: true))
precondition(!accepts("http://127.0.0.1:4317", local: false))
precondition(!accepts("https://localhost", local: false))
precondition(!accepts("https://[::1]", local: false))
precondition(!accepts("https://127.0.0.2", local: false))
precondition(!accepts("https://bot.localhost", local: false))
precondition(accepts("https://gateway.example", local: false))
precondition(!accepts("http://gateway.example", local: true))
precondition(!accepts("https://user:secret@gateway.example", local: false))
precondition(!accepts("https://gateway.example?token=secret", local: false))
precondition(!accepts("https://gateway.example/#secret", local: false))
precondition(!accepts("https://gateway.example/rpc", local: false))
print("Connection policy: 12 checks passed")
