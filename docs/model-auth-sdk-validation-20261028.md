# Model authentication repair — 2026-10-28

Scope: the existing Astra development branch, based on `9369cb3`. No provider grant, user credential entry, network permission, paid inference, push or release was performed.

## Verified root cause and SDK contract

The running `development-harness-next/Pibo Development.app` embedded Pi AI, coding-agent and agent-core **1.2.0**. Their installed package files and provider/OAuth exports matched the lockfile and bundled copies. `pi-subagents` was 0.77.0. The native process and its real builtin Node child were observed, and the child's unauthenticated `/readyz` returned HTTP 200/ready. This was not a fixture runtime.

The old native `runtime_request` rejected every non-GET `/pi/*` operation except `/pi/model` **before dispatch**. The renderer translated that native rejection into “connection interrupted / result unknown.” Consequently the observed failure did not establish a provider outage or OAuth polling timeout.

`PiSettings.startLogin` correctly starts `ModelRuntime.login(provider, type, {signal,prompt,notify}, options)` asynchronously and immediately returns a login ID. The HTTP connection does not wait for OAuth completion.

The SDK registers separate providers/methods:

- `openai`: API key and OAuth with the official **Sign in with ChatGPT** label. Its current ChatGPT implementation uses a browser callback/manual redirect URL, not the legacy device-code branch.
- `openai-codex`: official SDK display name **OpenAI Codex (legacy)**. Offers browser and **Device code login (headless)** choices. The latter supports approval from another device while the runtime polls, with a 900-second SDK window.

Primary source: [OpenAI provider](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/src/providers/openai.ts), [ChatGPT OAuth](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/src/auth/oauth/openai-chatgpt.ts), [legacy device OAuth](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/src/auth/oauth/openai-codex.ts). Installed source was inspected as the authority for the actual bundle.

## Implemented changes

- Expose actual SDK method labels, preserving official provider identities.
- Native bridge allows strictly shaped non-secret controls. Text, API keys and redirect codes remain in an independent native-bound secure input window. Each select answer is checked against the current server prompt/options.
- A system browser command accepts only exact HTTPS URLs present in the current pending SDK login events. It is independent of the Tailscale authorization flow.
- Cancellation, runtime changes and duplicate submissions invalidate secure-window claims. Native policy errors retain accurate `code/message/submitted` semantics.
- Client-generated request IDs make starts recoverable by read, without replaying ambiguous OAuth starts. Cancel/close invalidates late reads/responses. Terminal states stop polling. The server honors the SDK's device approval expiry instead of cutting it off at ten minutes.
- Initial setup opens directly at provider and login-method selection. Confirmed credentials lead to explicit available-model selection, then Finish saves and returns to chat. Existing configurations open the current model with one upper-right Manage connection action. The lower duplicate was removed; advanced reasoning is disclosed only for usable reasoning models. No empty model detour, false dirty state or invalid save control remains.

## Completed automated checks

- `npm run check`: passed.
- `npm run gui:check`: passed.
- `npm run gui:build`: passed, with existing module-directive/chunk-size warnings.
- `node --import tsx --test test/pi-settings-client.test.ts test/pi-login-flow.test.ts test/pi-oauth-contract.test.ts test/pi-settings.test.ts`: **24/24 passed**. HTTP tests use temporary loopback listeners and synthetic credentials. The initial sandbox execution could not bind; the approved execution passed.
- The actual installed SDK's device-code implementation was exercised with mocked network responses. Tests cover immediate begin/input responses while OAuth remains pending, deduplication, the 15-minute window, cancellation with late mocked token responses, and no token exposure in public state.
- Native policy, browser-link validation and secure-window cancellation tests: **26 passed, 1 pre-existing ignored**, including stalled response headers/body deadlines and normal RPC isolation. Android Rust/JNI and Kotlin compilation passed. These are mock/compile checks, not device login acceptance.
- `21st review` reported only pre-existing hardcoded color/token informational findings; no new auth-layout blocker. `git diff --check` passed.

## Final native and UI acceptance

- Normally quit the old development app, then launched `artifacts/development-oauth-20261028/Pibo Development.app`. Read-only NSWorkspace/CoreGraphics inspection identified actual candidate **PID 52891**, visible window 4077. It restored the real builtin workspace and existing conversation. The dev frontend remains `127.0.0.1:5194`.
- Native candidate binary SHA256: `4fc7e6d2bb24615c45104fef9d1f3f4fb562530552b69abf9478b0d37173a79a`. Embedded Pi 1.2.0 and Tailscale SDK retained. Candidate `codesign --deep --strict` validation passed. Detailed build/sync records: `artifacts/development-oauth-20261028/candidate.json`.
- Actual native UI: default-model single upper-right entry; OpenAI exposes Sign in with ChatGPT separately from API key; Back returns without dirty/cancel notices when no login started; closing settings returns to the existing chat. Only navigation/read actions were taken. No real grant or secure-input submission occurred.
- Chromium isolated UI QA: **30 checks passed, 0 failed**, including 393×852, 320×568 and 874×402 layouts, internal scroll, duplicate actions, draft survival across polling, cancel/late responses, uncertain response recovery and mock device-code events. Reports preserve initial automation failures and their selector/scroll fixes instead of hiding them. Final evidence: `artifacts/model-auth-review/model-auth-final.json`.
- QA was explicitly labelled synthetic; its server at 5196 and browser session were stopped after validation. Native iOS/Android keyboard and real provider authorization were not exercised this round. Android validation remains compile-level only.
- The QA log exposed an existing Radix Select undefined-to-controlled warning; the empty selection is now kept controlled as an empty string. The visible behavior is unchanged.

## Provider-first follow-up

The user's final workflow correction supersedes the earlier empty-model screenshot: an unconfigured workspace now opens directly at provider/method choice. `12-native-provider-first.png` is the actual live Mac first-run screen (`libfile_f01787a2b74081918ad9e625da8c7e96`). No login was initiated. Confirmed credentials advance to explicit model choice; there is no automatic model selection. Finish saves and closes Settings. Existing configurations retain the single upper-right management entry and their current model when returning from authentication. Reasoning options are behind More options.

Provider-first incremental UI QA passed **45/45**, including the full completion/reopen sequence at 393×852, 320×568 and 874×402, retained existing models, cancel and unknown-state recovery, completed OAuth without confirmed credentials, configuration read failures and localized SDK method options. The Select controlled-state warning did not recur. New screenshots 13–23 and `artifacts/model-auth-review/model-auth-provider-first-results.json` preserve this run; the earlier 30-check report is retained separately. The test server and browser were stopped again.

The development native binary/backend are the verified candidate above. Subsequent provider-first changes are frontend-only and are served live from this checkout by port 5194; the candidate's bundled source manifest records the earlier packaging snapshot, not these later HMR edits.

## Delivered screenshots (earlier stage and latest flow)

| Screenshot | Library ID | Kind |
| --- | --- | --- |
| Default-model single entry | `libfile_3c811783f00c8191aacb602fab18e6fd` | Actual Mac native window |
| ChatGPT / API key entry | `libfile_b06523d86bcc8191af2db36a7ee107ae` | Actual Mac native window |
| 320px auth form | `libfile_21a4787ba280819186c031901d2351df` | Browser QA; fake data |
| 874×402 landscape | `libfile_0fd6d5aa43ac8191a9cc0f9771f44df4` | Browser QA; fake data |

Files are under `artifacts/model-auth-review/`. Library identity was applied to each local screenshot. Real provider authorization remains for the user; no claim of completed real OAuth or paid-model chat is made.

Latest flow deliverables:

- Actual Mac provider-first entry: `libfile_f01787a2b74081918ad9e625da8c7e96`.
- 393px provider-first browser QA: `libfile_298ab650f8108191ad16ce2c76cfa34e`.
- 320px hand-selected model / Finish browser QA: `libfile_0ae02697384c81918129ab75c4b588e6`.
- 874×402 configured model browser QA: `libfile_33d850a7145481919d1d2595d95120ec`.

The QA examples carry an explicit synthetic-data label. They do not represent a user OAuth grant or configured production model.
