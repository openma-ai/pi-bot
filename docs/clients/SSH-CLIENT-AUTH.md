# iOS SSH authentication and lifecycle

The client connects to an existing independently started runtime over a strictly
pinned SSH session. There is no local agent execution on iOS and no remote service
provisioning. Desktop keeps system OpenSSH and its existing local/remote behavior.

## Supported credentials

- Password authentication, with optional subsequent keyboard-interactive checks.
- Imported Ed25519/RSA software private keys. Encrypted OpenSSH Ed25519 and RSA
  were exercised against the disposable server, including wrong-passphrase rejection.
  The native parser also accepts supported PEM encodings; not every PEM cipher/KDF
  combination was verified. The RSA negotiation requires SHA-2 and never falls back
  to SHA-1. Unsupported formats/algorithms fail with a fixed actionable message.
- Keyboard-interactive: up to eight bounded rounds and eight prompts per round;
  responses are masked regardless of the server's echo preference. Prompts are
  untrusted server text, capped and control-character filtered. No browser/push,
  security-key touch, SSH agent, SSH certificate or OpenSSH alias/config support.

Select the key file through the system file input; contents are not rendered.
The import is capped at 128 KiB. A new runtime's credentials are memory-only by
default. Explicitly checking **save to this device Keychain** stores credentials
with WhenUnlockedThisDeviceOnly protection, no sync, bound to profile/SSH identity.
Encrypted-key passphrases are included in that opted-in protected record. The
app clears unused credential fields and clears editor inputs after saving.
Deletion or SSH identity change removes the old record. Legacy saved passwords
remain readable. Deleting a profile forgets both old and new credential formats.

No secret belongs to runtime Profile JSON, localStorage, model/chat requests,
status URLs or app events. Challenges emit only bounded server prompt text and
an opaque one-shot identifier. Responses use a native command and are consumed
by SSH, never by the daemon event store. Native owned credential buffers are
zeroized on drop; third-party SSH/IPC internals may own additional temporary
copies, so this is not a claim of forensic elimination of every memory copy.
There are no credential-bearing debug logs or production test credentials.

## Cancellation and reconnect

Network/MFA awaits do not hold the shared runtime mutex. A generation check
prevents an old connection from being installed after cancel, remove, configure
or another connection. Cancel retires only the client connection, never the remote
agent's tasks. Connection has a 180-second total limit; SSH handshake 12 seconds,
password/key/server-response waits 20 seconds and individual human challenges 90
seconds. Event response headers time out after 15 seconds; ordinary iOS HTTP
requests have a 30-second deadline while SSE bodies remain open intentionally.

Settings provides **reconnect** and **cancel connection**. Going to background
retires the connection; returning foreground reconnects and loads a fresh snapshot.
A terminated app or locked Keychain may require re-entry/unlocking. There is no
promise of always-on iOS background execution. Reconnection never repeats a user
turn, and complete message presentation, per-bot Running and runtime-scoped pins
remain shared with desktop. Automatic retry while continuously foregrounded uses
the SDK's event reconnection; a dead SSH session can require the explicit reconnect
action rather than an unbounded silent authentication retry.

## Actual verification

- 9 opt-in native tests, using the isolated loopback fixture only: encrypted
  Ed25519 and RSA, wrong passphrase and wrong challenge response, cancellation,
  dropping a blocked challenge future at a deadline then reconnecting, changed
  host-key rejection, bad password, authenticated RPC, SSE, forced disconnect and
  reconnect, plus transport/install regressions. Run sequentially because one
  fixture test deliberately disconnects the server's owned sessions:

  `PIBOT_SSH_FIXTURE_ROOT=/tmp/pi-bot-ios-remote-fixture-ssh-v2 cargo test --manifest-path clients/tauri/src-tauri/Cargo.toml --features client-fixtures --lib -- --test-threads=1`

  The fixture root requires `client-test-key` and `client-test-rsa`, generated with
  `ssh-keygen` and passphrase `fixture-key-passphrase`; never use real user keys.
  The fixture server accepts only these disposable public keys and its dummy code.
- 7 default desktop native tests, 28 shared UI/layout/identity/profile tests,
  ESLint and TypeScript passed. Runtime-profile schema rejects password, key,
  passphrase and answer fields; credentials travel separately over native IPC.
- Actual iPhone 17 / iOS 26.4: encrypted Ed25519 import into Keychain, load and SSH
  authentication were exercised natively before showing a real interactive dialog.
  Real XCTest touch/text events entered the masked dummy response, submitted it,
  loaded the conversation list, sent a message, received the complete reply, then
  pressed Home and activated the app; the conversation recovered. Simulator cargo
  checks, simulator app build and unsigned device archive succeeded.
- Native iOS Files-picker selection, real device/remote server, multi-factor
  server policy combinations, advanced MFA and OS termination were not verified.
  The MFA policy fixtures verify keyboard-interactive independently; do not claim
  every real server's password-plus-key-plus-MFA sequence was tested.

Screenshots: [challenge](https://chatgpt.com/api/library/files/libfile_905498c2eb608191a275009fcc59fdaf/download)
and [foreground restored](https://chatgpt.com/api/library/files/libfile_457f679191348191af24c5c3b2c8e549/download).
The temporary XCTest coordinate harness is evidence under local `artifacts/`,
excluded from the shipping Xcode project and from the device archive.

## Refreshed unsigned artifact

`Pi-Bot-iOS-SSH-v2-unsigned-0.1.0-build1.zip` contains the refreshed device
xcarchive, not an installable IPA. Bundle `dev.pibot.ios`, version 0.1.0, build 1,
no Apple Team or signing. Size 6,657,326 bytes; SHA-256
`421d4bb669426396c0d124cd70504dfed62a35f42ba06f073b9f9de5ab86da06`.
Library `libfile_c9b78088b2c08191b8616a4529abc9f2`. The previous Mac package
was not replaced. The release app was checked for absence of fixture environment
markers, disposable credential values, actual dummy key material, XCTest bundles
and provisioning profiles. The checked test/build logs had no dummy secret values.
This proves the specified checks, not a guarantee about every third-party log.

Android tool installation and the disclosed SDK agreement were explicitly approved.
The arm64 debug client and local AOSP emulator are documented in
[Android test build](ANDROID-TEST-BUILD.md). Android uses only native session memory,
with no plaintext persistence or desktop process fallback. iOS Keychain behavior
remains unchanged.
