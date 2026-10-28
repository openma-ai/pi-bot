# OAuth callback, waiting state and model catalog — 2026-10-28

Follow-up to `020a098`, archived on `wip/astra-oauth-catalog-20261028` and continued after `8e74d2a`. The user's completed ChatGPT login was preserved. No new real OAuth grant, token inspection, account inference, service restart or release was performed during this repair. Source archival and follow-up pushes were separately authorized.

## Observed running application

The actual `development-oauth-20261028/Pibo Development.app` remained PID 52891, using the frontend at `127.0.0.1:5194`. The earlier observation showed OpenAI connected and an empty default-model selection. The later read-only window check showed GPT-6 Sol (`openai/gpt-6-sol`) saved, with an explicit note that this running runtime had not supplied catalog refresh metadata. No credential file was read. The running native binary SHA256 remains `4fc7e6d2bb24615c45104fef9d1f3f4fb562530552b69abf9478b0d37173a79a`.

The previous user chat task showed `executionFailed` / interrupted execution. That is not proof of working inference, and its cause has not been diagnosed. This work did not retry the task or make a real model call.

The existing bundle and installed Pi packages are 1.2.0, as recorded in `model-auth-sdk-validation-20261028.md`. Later frontend source changes are served by Vite; changing source alone does not upgrade the embedded harness or native binary.

## Automatic callback is the normal local flow

Installed `@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js` defines loopback port 1455 and `/auth/callback` (lines 19–22), starts the callback server before emitting the authorization URL, and races callback with manual input (lines 223–234). The manual prompt is a fallback emitted in parallel, not an additional required login step. It is cancelled in `finally`, after token exchange finishes (line 243). Pibo previously rendered that fallback as the main credential form.

The new UI shows waiting, exchange, uncertain transport and terminal states distinctly. It allows reopening the same authorization page and cancelling the same session. Manual input is collapsed under “无法自动完成？” and never opens a window automatically. Its field is “授权回跳地址”. Existing secure input isolation remains. Native completion checks close only windows bound to that endpoint and flow; pending or unrelated windows remain open.

Local builtin harness plus browser on the same machine can use loopback, as the user's actual success demonstrates. A remote harness cannot receive a callback aimed at the client's localhost. The UI states this boundary and exposes the SDK's existing legacy device-code option without silently switching the current model or starting a grant. `openai` and `openai-codex` remain distinct registered providers; only the latter offers device code in Pi 1.2.0.

## Model list: verified comparison with Pi itself

Pi's real `ModelSelectorComponent` uses `getAvailableSnapshot()` (installed `dist/modes/interactive/components/model-selector.js:104`) and catalog refresh (`:133`). `ModelRuntime.create` wraps builtin providers with `withRemoteCatalog` (`dist/core/model-runtime.js:88`); public catalogs are retrieved from `https://pi.dev/api/models/providers/openai?types=chat,image,classifier`, with a four-hour cache. Login synchronization alone uses `allowNetwork:false` (`model-runtime.js:404–419`). Pibo previously read `getModels()` without the selector's refresh/availability path.

The initial repair used SDK refresh followed by its authenticated `getAvailable()` result, and rechecked the same policy on save. That generic SDK path remains appropriate for non-SIWC providers, but does not establish ChatGPT account availability. Its metadata remains `accountAccess:'unverified'`. No model names are hardcoded or removed for age.

Crucially, replacing that API does **not** remove all old model names. With identical synthetic OpenAI OAuth, the real Pi 1.2.0 selector in default `all` scope renders 44 chat models, including GPT-4/Turbo/4.1. Explicit scope/search changes the list; the current/default model changes ordering. The anonymous public catalog returned HTTP 200 and still contained those names (Last-Modified 2026-10-27 13:51:17 GMT). This is a public directory, not a per-account entitlement endpoint. We did not inspect the user's prior CLI scopes or test model entitlement with paid inference.

## Current ChatGPT account directory

[OpenAI's SIWC direct-flow specification](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) requires an authenticated `GET https://api.openai.com/v1/models`. The new adapter uses the account response's visible entries, server order, display names and slugs. Pi still supplies the model execution specifications; a public Pi catalog never substitutes for a failed account request.

`OpenAIAccountModels` runs only for the official `openai` OAuth route. API-key and legacy `openai-codex` connections keep their distinct SDK paths. SDK credential resolution remains inside the runtime; the adapter sends only the resolved bearer to the fixed official URL, rejects redirects/custom routes, bounds the request to eight seconds and the response to 1 MiB, and never exposes raw account errors or credentials. The SDK may perform its normal token refresh when resolving authentication; no refresh was performed against the user's account in these tests.

Unknown or incompatible SDK specifications are excluded and counted explicitly rather than guessed into executable models. Account-query failure yields no selectable ChatGPT choices. Login/logout invalidates in-flight reads, a second authentication check discards late account-switch results, and model save rechecks the account directory. No cross-request account/token cache is added.

Provider metadata distinguishes `source:'openai-account'` and `accountAccess:'confirmed'` from the generic SDK directory. Here, confirmed means a successful account-directory response, not successful inference. Unsupported specifications and failed/unconfirmed reads have separate UI explanations. These contracts were tested with isolated synthetic OAuth; a real read of the user's account directory has **not** yet been run through the rebuilt application.

## Validation and activation boundary

- Integrated TypeScript/SDK/UI-state tests: 58 passed. Includes the actual registered browser and device implementations with mocked external responses, random loopback listeners, actual TUI render comparison, public/account catalog separation, authentication changes, bounded requests, cancellation and late responses. No listener uses the user's real port 1455. A first sandbox run could not listen (`EPERM`); the approved isolated run passed.
- Native secure-window/policy suite: 30 passed, one pre-existing ignored. Credential page mock tests: four passed (also included in the 45 above).
- TypeScript, GUI ESLint, GUI production build and dedicated credential-page build passed. Existing Vite module-directive/chunk-size warnings remain.
- Browser regression: 128 passed (50 fallback/waiting, 33 base, 45 provider-first), with 37 screenshots. Desktop, 393×852, 320×568 and 844×390 viewport cases cover waiting, collapsed manual fallback, cancellation, terminal completion, account-directory failure and partial SDK compatibility. An initial fixture contract mismatch was corrected before the passing rerun. These tests use fake authentication and a mocked native bridge; they do not establish native iOS/Android keyboard behavior or real provider entitlement.
- The existing app's actual bundled harness passed its isolated lifecycle test: startup, explicit missing-model error, duplicate ownership, unrelated-runtime preservation, graceful stop, restart and crash recovery. All data and model configuration were temporary; the user's authenticated runtime was untouched. This validates the existing bundled harness, not activation of the newly changed backend.

New backend refresh and native window-close commands require the next normal development-app rebuild/restart. The current authenticated app was not restarted or its bundle replaced in this turn. Frontend compatibility handles older binaries and missing catalog metadata without claiming refreshed availability.

## Activation and remaining acceptance

The earlier usage/connection interruption is resolved for source integration and isolated browser verification. All three browser scripts now reflect the collapsed fallback and account-directory metadata, and the compact waiting page has been captured. The terminal secure-window behavior is covered by native policy/unit tests and browser bridge mocks, but not by the updated runnable Mac app.

Only four earlier frontend files reached the live checkout before archival. The source in this WIP branch is the complete follow-up. The running native binary and builtin harness still use the prior candidate; neither was restarted or replaced. A newer Cargo unit-test executable is not an app and was not substituted for it. Real OAuth success was user-performed and observed read-only; no new grant or inference was initiated.

The final read-only disk check reported 732,976 KiB available (about 716 MiB). No files were deleted. Estimated build headroom is at least 3 GiB for a preserved native candidate (4 GiB preferred), 5 GiB for the complete Docker build (6 GiB preferred), and 6 GiB for Android. These are resource estimates, not measured peak usage. The full native replacement, Docker build/isolated persistence acceptance, and Android APK build remain blocked by insufficient free disk space. Other desktop architectures have not been built or run.

After sufficient disk space is available, first confirm no active authentication/task before replacing the development candidate. Then verify the real account-directory read, matching secure-window closure, native layout and runtime recovery. This work does not authorize or require new OAuth grants, credential transfer, real model inference, system-service changes or a release.
