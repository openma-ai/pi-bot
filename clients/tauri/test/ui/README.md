# Local UI acceptance fixture

Run from the repository root:

```sh
node --import tsx clients/tauri/test/ui/serve.mjs
```

Open localhost port 5189 (override with `PIBO_UI_PORT`):

- `/clients/tauri/test/ui/index.html`: first-run desktop.
- Add `?phone=1`: remote-only / phone first run.
- Add `?returning=1`: a synthetic saved profile.
- Add `?returning=1&success=1`: Continue connects to a disposable real local
  runtime containing a synthetic bot, never to the profile's example host.
- Add `?phone=1&returning=1&tailnet=1&key-error=1`: application authorization error.
- `/clients/tauri/test/ui/images.html?unsupported=1`: generated 64×48 PNG with
  a text-only-model warning; preview and original Blob download work.
- Add `?denied=1` to images page: simulated authorization/download failure.

The fixture runs only on loopback, intercepts native calls, never starts a real
Tailnet node and uses an empty, disposable Pi directory. Its session factory has
no model/provider calls. Native save/share are mocked; do not interpret this as
physical-device or native-sheet testing. Existing user runtimes, settings and
photos are not read or changed. Stop with Ctrl-C.
