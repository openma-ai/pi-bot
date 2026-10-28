# Local UI acceptance fixture

Run from the repository root:

```sh
node --import tsx clients/tauri/test/ui/serve.mjs
```

This is **not a usable model-chat development app**. It contains no model executor.
Use `npm run dev` in `clients/tauri` for the real native frontend and connect an existing runtime in Settings.
For the optional embedded network, use `npm run dev -- --features embedded-tailscale`
with `PIBO_TAILSCALE_LIB_DIR` pointing to the prepared platform archive. This
build option does not log in or start a system VPN.

Open localhost port 5189 (override with `PIBO_UI_PORT`):

- `/clients/tauri/test/ui/index.html`: first-run desktop Settings entry.
- Add `?phone=1`: remote-only / phone first run.
- Add `?returning=1`: a synthetic saved profile.
- Add `?returning=1&success=1`: Settings connects to a disposable local
  UI fixture containing a synthetic bot, never to the profile's example host.
- Add `?phone=1&returning=1&tailnet=1&key-error=1`: application authorization error.
- `/clients/tauri/test/ui/images.html?unsupported=1`: generated 64×48 PNG with
  a text-only-model warning; preview and original Blob download work.
- Add `?denied=1` to images page: simulated authorization/download failure.

The fixture runs only on loopback, intercepts native calls, never starts a real
Tailnet node and uses an empty, disposable Pi directory. Its session factory has
no model/provider calls. Native save/share are mocked; do not interpret this as
physical-device or native-sheet testing. Existing user runtimes, settings and
photos are not read or changed. Stop with Ctrl-C.

Direct Tailnet flow: `?phone=1&approve=1&success=1` simulates browser approval,
returns two synthetic peers (one offline), and enables mocked service checking
and pairing. Omit `approve=1` to test cancellation. `window.__PIBO_TEST__` exposes
only this fixture's synthetic state and native call names for duplicate/lifecycle
assertions; it is not included in production UI.

## Offline desktop toolbar layout

`node clients/tauri/test/ui/desktop-serve.mjs` serves loopback 5191. Open
`/clients/tauri/test/ui/desktop.html` with the independent `pibo-toolbar`
agent-browser session, open the screen and take control, then run
`python3 clients/tauri/test/ui/desktop-check.py`. Only this fixture server aliases
RFB to an explicitly labeled synthetic canvas; the production build is unchanged.

The geometry checks cover 402x874, 874x402, 320x568, focused-input viewport
402x390 and 874x250. Buttons must be 44px high, share the same top, and remain
within the viewport; status shares their top except in the deliberate narrow
two-row layout. Actual iOS software keyboard/device behavior is not established
by this desktop-browser simulation. Separately setting the existing
`--phone-height` to 390px with a full 874px layout viewport checks the same
VisualViewport override used by the production App.

The original ghost button was content-box with negative margins and had a
different baseline/size. The footer now centers a status and an action group,
normalizes button border-box/height/margins, and wraps on 320px screens. Dialog
width respects the Radix padding; max-height includes its 32px/6vh margins and
safe-area insets. Only this desktop dialog overlay uses the App's existing
VisualViewport height variable. No networking, lease or authentication behavior
changes. Evidence is in ignored `artifacts/desktop-toolbar`.

## Formal cream/coral visual refresh QA

See `docs/astra-visual-refresh.md` for scope and limits. On loopback port 5193,
`astra-check.py` covers mobile routes, model configuration and failure/cancel
flows; `astra-extra-check.py` covers restore cancellation and simulated native
Mac titlebar geometry. Both use a dedicated `pibo-astra` browser session.
Additional query flags: `connected=1`, `models=1`, `story=1`, `restore=1`,
`slow=1`, `model-error=1`, `create-error=1`, and `mac=1`.
Model data and story messages are explicitly synthetic. No real credentials
or model calls are involved. Keyboard and native flags remain browser
simulations, not device certification.

`python3 clients/tauri/test/ui/disconnect-check.py` uses the independent
`pibo-disconnect-final` browser session on loopback 5193. It verifies title-inline
connection feedback, preserved offline conversations/drafts, disabled writes,
stable failure/cancellation, Settings reconnect/switch, first configuration,
44px actions and narrow/landscape geometry. Evidence is in
`artifacts/disconnect-review`; native acceptance and remaining limits are in
`docs/astra-disconnect-followup.md`.

## Built-in harness landing QA

`python3 clients/tauri/test/ui/harness-landing-check.py` uses the existing loopback
5193 server and a dedicated `pibo-harness-qa` browser session. The `builtin=1`
flag models only the native lifecycle status, never starts a harness, and is
explicitly UI-only. `unavailable=1` exercises missing packaged resources.
The script covers desktop local/remote choices, protected builtin profile,
failed/duplicate starts, cancel, mobile remote-only entry, narrow/landscape,
and a synthetic successful connection. Real harness lifecycle evidence comes
from the Rust and packaged-Node integration tests, not this fixture.

Native dev and UI QA Vite caches are separate (`.vite-native-dev` and
`.vite-ui-qa`) so concurrent QA cannot remove the native Tauri import bundle.
