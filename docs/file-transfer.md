# Bidirectional client file transfer

Implemented on top of `feat/embedded-tailscale`, with upstream `main@7c78b35`
checked again before work (no newer upstream commits). Both ordinary native
SSH/direct runtime access and embedded userspace Tailnet use the same protocol.
No arbitrary filesystem path is a download URL.

## Protocol and limits

The authenticated, initialized SDK connection exposes `file.begin`, `append`,
`finish`, `read`, and `cancel`, over the existing `/rpc` transport. Each chunk is
Base64 inside JSON. This is a binary-safe wire encoding: raw binary never passes
through the native bridge's UTF-8 response conversion. No broad HTTP/file route
was added, no runtime bearer token is exposed to JavaScript, and existing
1-MiB RPC limits remain intact. Each request/response contains at most 256 KiB of
binary data (349,528 Base64 characters). Complete files are SHA-256 checked at
upload finalization and again after download.

- 8 MiB per file; at most four attachments per message.
- Any binary file type is accepted. MIME is a display hint; malformed values
  become `application/octet-stream`. Attachments are never rendered as HTML,
  auto-opened, executed or implicitly trusted as instructions.
- Filenames are limited to 120 characters. Separators, traversal names, control
  characters and bidi control sequences are rejected. Storage filenames use UUIDs.
- Vault quota: 256 MiB / 512 records. Unsent/unbound uploads expire after 24 hours
  when a subsequent upload triggers cleanup. Bound chat files are retained;
  deleting historical files / retention settings are outside this MVP.
- Cancellation stops subsequent chunks and attempts to remove unbound uploads;
  a currently in-flight RPC may finish. Bound files cannot be removed via cancel.
  Chunks support same-offset identical replay, reject conflicting/out-of-order
  data and cannot mutate a finalized file. Business turns are not auto-replayed.

`turn.start` accepts optional attachment IDs. The host validates readiness,
owner and conversation scope before queuing, binds the records after acceptance,
and projects immutable metadata into chat history/file cards. Ordinary text
messages omit the attachment field, preserving old-runtime chat compatibility.

## Agent access and generated files

The inbox contains attachment metadata and an explicit untrusted-data notice,
not file contents spliced into user instructions. The native `file_workspace`
tool returns the current source task's authorized input paths and a private
output directory. `publish_file` accepts **one filename**, MIME and an idempotency
key; the agent first writes that deliverable in its output directory. Publication
reads only a bounded regular file there, refuses symlinks/hardlinks/traversal,
creates an immutable vault snapshot, and commits an outbox message/file card
against the conversation revision. It does not grant disclosure authorization.
Stale/cancelled tasks remain subject to the runtime's existing task checks.

The OS-level agent tools retain their pre-existing filesystem privileges. This
change confines the file-publication API; it is not a new OS sandbox for bash.

## Identity and conversation boundary

File methods derive ownership from the authenticated transport, never RPC input.
HTTP cookie-session identities are hashed before persistence; cookies and bearer
secrets are not stored in attachment metadata. File reads/mutations require the
record's owner and bot/conversation/thread scope to match. Snapshots/events filter
file-card metadata for other owners. Unknown IDs or arbitrary paths cannot become
downloads. The native shared runtime bearer is the existing **host/admin**
principal: clients sharing it share that identity. This does not add independent
user accounts or make the entire pre-existing runtime multi-tenant. Browser
cookie identities are session-bound; after a cookie/server-session reset their
old private file records are not automatically reassigned. A durable account
system would be a separate feature.

On disk, the vault lives beside the runtime database in `files/`, private
directories use mode 0700, and manifests/data files use mode 0600. Input bytes are
not embedded in snapshots or model inbox JSON. Output workspaces are separated
by a digest of owner plus conversation scope. Stored file paths stay inside the
host agent context; the client receives IDs/metadata and bounded chunks.

## Client behavior

The composer supports up to four selected files, upload cancellation and removal
of unsent attachments. File cards show name, size, MIME and a download action.
Downloads verify bytes before export. The browser uses an inert Blob download.
Apple native clients use the `file_export` command, which validates the filename
and size, decodes Base64 to bytes and stages a private temporary file:

- macOS: `NSSavePanel`; the user explicitly chooses a destination, cancellation
  is respected, and atomic data writing avoids partial destination files.
- iOS: `UIActivityViewController` with a file URL; the sheet provides sharing and
  the system's Save to Files action. iPad popovers are anchored correctly.

The native bridge has no caller-supplied source or destination path. Temporary
staging is deleted after completion/cancellation; a forced process termination
can leave a temporary directory. No destination is selected or file shared
without the user's native UI action. Native Android export remains unsupported;
this task implements the requested Apple clients.

## Verification

Only synthetic files and disposable localhost runtimes were used. No real
Tailnet, user document, cloud upload, live model/provider, installation or
TestFlight/GitHub deployment was involved.

- TypeScript check and native GUI production bundle pass.
- Relevant JS suites: 22 tests pass, including actual authenticated HTTP chunk
  upload → simulated agent reads bytes → generated file publication → projected
  file card → byte-identical download; corrupt checksums, cancellation, cross
  owner/conversation access, metadata filtering and safe card escaping.
- The explicit offline libtailscale C double tests JSON/Base64 binary file chunks
  through Unix socketpair → real SSH → HTTP, alongside HTTP/SSE/WebSocket and
  reconnect checks. This is not real Tailnet validation.
- Native Rust unit tests: 10 passed with the real userspace library linked, without starting a node; explicit C-double tunnel test: 1 passed.
- macOS native executable and an ad-hoc-signed local `Pibo Preview.app` build.
- iOS static library including the Objective-C UIKit bridge builds; a full local
  **unsigned** `pi-bot-desktop_iOS.xcarchive` also builds, with no install/upload.
- Native save/share UI interactions, actual file picker behavior on a physical
  iPhone/iPad, real model tool use, real Tailnet/VPN coexistence and device
  background/foreground behavior remain unverified. Build success is not a
  device test or proof of successful sharing to an external app.

Build the platform archive with `clients/tauri/scripts/build-embedded-tailscale.sh`
first. `build.rs` now also locates its target-specific `.tailscale-build` output
without an environment variable because the Tauri Xcode phase filters arbitrary
environment variables; `PIBO_TAILSCALE_LIB_DIR` remains an explicit override.
