# Harness build resource preflight — 2026-10-27

This follow-up is a resource and packaging-contract check, not a successful
Docker image or Android APK build. No image pull, cache pruning, disk cleanup,
SDK installation, login, host service change, or real-container restart was
performed. Mac native UI acceptance remains blocked by the locked screen.

## Resource observations

The host APFS data volume had 3,733,364 KiB (3.56 GiB) available at the Docker
inspection; other samples were approximately 3.55 GiB. Docker reports 12 CPUs
and 8,221,806,592 bytes (7.66 GiB) of memory. The two existing live containers
used approximately 755 MiB together and were left running.

Docker disk inventory: 30 images / 8.439 GB, 17 containers / 1.382 GB,
8 volumes / 235.7 MB, and 108 build-cache records / 74.66 MB. Reclaimable figures
are not permission to remove anything. The virtual capacity of Docker.raw does
not establish that the host has physical space for new writes.

## New Dockerfile build — not started

The exact arm64 `node:24.18.0-bookworm` base is cached (`f1158c7f34cf…`,
1,131,192,057 bytes). Its existing layers need not be downloaded again. The new
`npm ci --ignore-scripts --no-audit --no-fund` layer has no exact cache hit;
older dependency layers use different parents and commands.

The exact files copied by `container/Dockerfile.harness` total 1,566,202 bytes
(205 files). The host dependency tree measures 522.3 MiB. The root
`.dockerignore` now excludes generated client resources, targets and artifacts:
the artifacts directory alone was about 2.11 GiB, and staged desktop harness
resources about 550 MiB. These are not inputs to either container build.

Estimated additional peak space is **1.6–2.7 GiB**, including the build-stage
dependencies, final-stage copy, npm cache and temporary image export. Estimated
final additional layers are 0.5–0.75 GiB. These are estimates, not measured
build peaks. At the current free space, the upper estimate leaves less than
1 GiB for the host and concurrent applications.

Use at least **5 GiB available, preferably 6 GiB**, before starting this build:
the current shortfall is about **1.5–2.5 GiB**. No cleanup was attempted.
Once capacity permits, the original build remains:

```sh
docker build --progress=plain -f container/Dockerfile.harness \
  -t pibo-harness:local .
```

The isolated cached-image deployment tests in
[deployment validation](harness-deployment-validation.md) do not substitute
for building this new image.

## Android APK — not started

Available official/local tools:

| Component | Confirmed location/status |
| --- | --- |
| Android SDK | `<user-home>/Library/Android/sdk`, API/build-tools 36 and command-line tools |
| NDK | SDK `ndk/28.2.13676358`, arm64 API24 clang and llvm-ar |
| JDK | `<user-home>/Library/Java/JavaVirtualMachines/openjdk-21.0.2/Contents/Home` |
| Gradle | 9.6.1 unpacked in the existing wrapper cache |
| Build dependencies | AGP 9.3.1, Kotlin 2.2.10, AAPT2 and direct app dependencies cached; about 1.12 GiB |
| Embedded SDK | Existing 29 MiB Android arm64 `libtailscale.so` and JNI packaging copy |
| Rust target | About 111 MiB of check metadata; no full target `.rlib` or app `.so` outputs |

The worktree lacks its Tauri CLI dependency link, but CLI 2.12.2 in the original
checkout was confirmed runnable with `android build --help`. It can be reused
through command-local PATH; no installation is required. The following generated
files are absent: `tauri.settings.gradle`, `app/tauri.build.gradle.kts`, and
Tauri/Wry activity Kotlin sources. Normal Tauri generation is expected to supply
them; a complete build has not verified that step. **buildSrc does exist**,
correcting the earlier coarse inspection.

Estimated additional peak space for one arm64 debug APK is **1.5–3 GiB** for
Rust code generation/linking and Gradle outputs. Allow at least **6 GiB free**
before attempting it, separately from Docker. This estimate is not an observed
APK build. No required new SDK/NDK/JDK/Gradle download has been identified, but
transitive dependency resolution has not been run, so a fully offline Gradle
build is not guaranteed.

After capacity permits, from `clients/tauri`, the cached-SDK route is:

```sh
(
  export ANDROID_HOME=<user-home>/Library/Android/sdk
  export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
  export JAVA_HOME=<user-home>/Library/Java/JavaVirtualMachines/openjdk-21.0.2/Contents/Home
  export PATH="<user-home>/Documents/Codex/2026-10-21/task/pibo/clients/tauri/node_modules/.bin:$JAVA_HOME/bin:$PATH"
  export CARGO_TARGET_DIR=<user-home>/Documents/Codex/2026-10-25/task/pibo-main-integration/clients/tauri/src-tauri/target
  export CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0
  export PIBO_TAILSCALE_LIB_DIR="$PWD/.tailscale-build/android/aarch64"
  npm run build:gui
  npm run tauri -- android build --features embedded-tailscale --debug --target aarch64 --apk --ci
)
```

This command builds only; installing an APK, starting a node or signing into
Tailscale is outside this follow-up. Existing Rust/JNI/Kotlin compile evidence
remains [separate](harness-android-build-evidence.json).

## Other desktop targets — source contract only

| Target | Checked contract | What is not proven |
| --- | --- | --- |
| macOS arm64 | Harness preparation and desktop package scripts accept this host; manifest requires matching platform/arch | Final native window click remains pending |
| Intel macOS | Preparation/package scripts explicitly reject a non-arm64 host; bundled harness availability is false | No matching Node/native dependency bundle or app built |
| Windows/Linux desktop | Package scripts reject the host; embedded SDK build feature currently asserts Apple/Android targets | No desktop app, native SDK library or harness package built |
| Linux headless harness | Independent Docker/installation path exists | Cached-image tests are not desktop-client or new-image acceptance |

These checks inspect `prepare-desktop-harness.mjs`, `package-desktop.mjs`,
`src-tauri/build.rs`, `builtin_harness.rs` and the resource mapping in
`tauri.harness.conf.json`. No cross-platform execution is claimed. Unsupported
resources do not become available merely because a saved builtin profile exists.
