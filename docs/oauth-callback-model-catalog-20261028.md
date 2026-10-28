# OAuth callback, waiting state and model catalog — 2026-10-28

Follow-up to `020a098` on `feat/astra-visual-refresh`. The user's completed ChatGPT login was preserved. No new real OAuth grant, token inspection, account inference, service restart, push or release was performed during this repair.

## Observed running application

The actual `development-oauth-20261028/Pibo Development.app` remained PID 52891, using the frontend at `127.0.0.1:5194`. Its main native window showed OpenAI connected and an empty default-model selection. This independently confirms that the user's browser success reached Pibo; no credential file was read. The running native binary SHA256 remains `4fc7e6d2bb24615c45104fef9d1f3f4fb562530552b69abf9478b0d37173a79a`.

The existing bundle and installed Pi packages are 1.2.0, as recorded in `model-auth-sdk-validation-20261028.md`. Later frontend source changes are served by Vite; changing source alone does not upgrade the embedded harness or native binary.

## Automatic callback is the normal local flow

Installed `@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js` defines loopback port 1455 and `/auth/callback` (lines 19–22), starts the callback server before emitting the authorization URL, and races callback with manual input (lines 223–234). The manual prompt is a fallback emitted in parallel, not an additional required login step. It is cancelled in `finally`, after token exchange finishes (line 243). Pibo previously rendered that fallback as the main credential form.

The new UI shows waiting, exchange, uncertain transport and terminal states distinctly. It allows reopening the same authorization page and cancelling the same session. Manual input is collapsed under “无法自动完成？” and never opens a window automatically. Its field is “授权回跳地址”. Existing secure input isolation remains. Native completion checks close only windows bound to that endpoint and flow; pending or unrelated windows remain open.

Local builtin harness plus browser on the same machine can use loopback, as the user's actual success demonstrates. A remote harness cannot receive a callback aimed at the client's localhost. The UI states this boundary and exposes the SDK's existing legacy device-code option without silently switching the current model or starting a grant. `openai` and `openai-codex` remain distinct registered providers; only the latter offers device code in Pi 1.2.0.

## Model list: verified comparison with Pi itself

Pi's real `ModelSelectorComponent` uses `getAvailableSnapshot()` (installed `dist/modes/interactive/components/model-selector.js:104`) and catalog refresh (`:133`). `ModelRuntime.create` wraps builtin providers with `withRemoteCatalog` (`dist/core/model-runtime.js:88`); public catalogs are retrieved from `https://pi.dev/api/models/providers/openai?types=chat,image,classifier`, with a four-hour cache. Login synchronization alone uses `allowNetwork:false` (`model-runtime.js:404–419`). Pibo previously read `getModels()` without the selector's refresh/availability path.

The repair uses SDK refresh followed by its authenticated `getAvailable()` result, and rechecks the same policy on save. It reports source, refresh status, configured authentication and `accountAccess:'unverified'`. Timeout/authentication errors do not turn a stale snapshot into selectable models. No model names are hardcoded, removed for age, or advertised as account entitlement.

Crucially, replacing that API does **not** remove all old model names. With identical synthetic OpenAI OAuth, the real Pi 1.2.0 selector in default `all` scope renders 44 chat models, including GPT-4/Turbo/4.1. Explicit scope/search changes the list; the current/default model changes ordering. The anonymous public catalog returned HTTP 200 and still contained those names (Last-Modified 2026-10-27 13:51:17 GMT). This is a public directory, not a per-account entitlement endpoint. We did not inspect the user's prior CLI scopes or test model entitlement with paid inference.

## Validation and activation boundary

- Integrated TypeScript/SDK/UI-state tests: 45 passed. Includes the actual registered browser and device implementations with mocked external responses, random loopback listeners, actual TUI render comparison, SDK public-catalog/cache protocol, cancellation and late responses. No listener uses the user's real port 1455. A first sandbox run could not listen (`EPERM`); the approved isolated run passed.
- Native secure-window/policy suite: 30 passed, one pre-existing ignored. Credential page mock tests: four passed (also included in the 45 above).
- TypeScript, GUI ESLint, GUI production build and dedicated credential-page build passed. Existing Vite module-directive/chunk-size warnings remain.
- Browser visual QA is explicitly synthetic and does not establish native iOS/Android keyboard behavior or real provider entitlement.

New backend refresh and native window-close commands require the next normal development-app rebuild/restart. The current authenticated app was not restarted or its bundle replaced in this turn. Frontend compatibility handles older binaries and missing catalog metadata without claiming refreshed availability.

## WIP publication checkpoint

This follow-up is archived without claiming final acceptance. The waiting-layout compacting change passed ESLint and a GUI build; its final screenshot was not recaptured after that last layout change. The new browser regression script and fixture were written but the full run was interrupted by agent usage exhaustion and a subsequent executor disconnection. The two earlier browser scripts still expect the old visible manual input and need adaptation to the collapsed fallback. They were not silently counted as passing.

Only four frontend files reached the live checkout before archival. The source in this WIP branch is the complete isolated follow-up. The running native binary and builtin harness still use the prior candidate; neither was restarted or replaced for publication. Real OAuth success was user-performed and observed read-only; no new grant or inference was initiated.
