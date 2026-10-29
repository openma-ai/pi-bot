# Model connections

Pibo keeps `providerId` (the Pi SDK provider/transport) separate from `connectionId` (the selected account). Built-in provider definitions and authentication methods come from the installed Pi 1.2.0 registry. Custom connections use the SDK's `registerProvider` API with `openai-completions` or `openai-responses`, an explicit HTTP(S) base URL and model specifications. They do not invent another OAuth protocol.

## Persistence and compatibility

`model-connections.json` in the configured Pi agent directory is versioned, secret-free metadata. UUID connections have independent SDK `ModelRuntime` instances, whose official `authPath` is `connections/<connectionId>/<credentialVersion>/auth.json`. Only SDK login/logout/refresh touches these files. State responses contain credential type, never credential contents.

Existing settings/auth remain addressable as `legacy:<providerId>`. Reading settings does not copy, migrate or rewrite legacy credentials. The version-0 metadata fixture upgrades in memory; the next explicit metadata save writes version 1 atomically. Interrupted temporary writes are ignored. Unknown versions and malformed bindings fail closed.

Create requests may provide a stable UUID; retrying the same create payload returns the existing connection. Updates and removal require `expectedRevision`. IDs must be lowercase UUIDs to prevent case-insensitive filesystem aliasing. Metadata writes use private files and atomic rename; writes are serialized by the single harness event loop. Running multiple harness writers against one agent directory is not supported.

## Binding and edits

Login flows, model choices, catalogs and logout carry the connection ID. A model selection is not inferred from provider/model names alone. Same-name models from two accounts stay distinct. Explicit connections do not use ambient API keys or ambient credential files when their own credential is missing.

Changing provider or any endpoint specification creates a new credential version. No credential is copied to the new location, even when only the path changes on the same origin. The connection must authenticate again. Existing requests capture their original SDK runtime and endpoint. The daemon applies new model configuration at its existing idle boundary; session journals record the explicit connection binding. An unavailable selected connection remains unavailable rather than falling back to another account.

Endpoint replacement/removal cancels only that connection's pending login and invalidates its catalog. A cancelled late SDK result cannot authenticate a replacement credential generation. Logout deletes the selected provider's credential in that connection through the SDK. Removing a connection deletes its metadata entry only; it does not claim remote revocation or erase old credential generations. It never deletes session history. Old credential-generation cleanup is a separate operation and is not implemented here.

## Private settings endpoints

- `POST /pi/connections/save`: `{id?, providerId, name, endpoint?, expectedRevision?}`; returns `{connection, requiresAuthentication}`.
- `POST /pi/connections/remove`: `{connectionId, expectedRevision}`.
- `/pi/login`, `/pi/model`, `/pi/logout` accept `connectionId`; pending login metadata reports it.
- `/pi/config` retains legacy `providers` and adds `connections`, `current.connectionId`, and `connectionManagement.endpointApis`.

The GUI saves no secrets through connection metadata. API keys, OAuth replies and provider-specific authentication fields retain the existing private/native secure-input path and target-runtime binding. URL credentials, queries, fragments, path traversal, duplicate path slashes and arbitrary headers/config fields are rejected.

## Validation boundary

`test/model-connections.test.ts` uses isolated temporary directories, synthetic credentials, official SDK calls and mocked fetch/provider implementations. It covers metadata idempotence/migration, same-provider/same-model accounts, restart, concurrent catalog reads, SDK request URL/auth binding, endpoint replacement during a request, login cancellation, late completion, ambient-auth rejection and per-account OAuth refresh locking.

These fixtures do not establish real account access, real OAuth login, billable inference, native binary compatibility or remote-provider availability. No actual user credential store is migrated by this verification. Repository-wide checks and native UI validation are reported separately by the integrating task.
