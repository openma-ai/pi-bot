# Android arm64 development APK

This is a native Tauri Android client, **remote-only**. It embeds the same pinned
SSH transport as iOS; it never uses desktop subprocess/OpenSSH/local-runtime code.
The first Android build deliberately supports **session-only native credentials**:
passwords, private keys and passphrases are kept in Rust memory and erased on drop,
not in profile JSON, WebView localStorage or plaintext files. Process death requires
re-entry/import. Persistent Android Keystore support is not claimed; saving secrets
to disk is rejected rather than silently falling back. Challenges use one-shot
native IPC; complete replies, bot-owned Running and runtime-scoped pins are shared.

## Toolchain and build

User approved official tool installation and explicitly accepted the disclosed
Google Android SDK License Agreement. Only `android-sdk-license` was accepted;
no preview/Google Play/cloud agreement was accepted. Official command-line tools
ARM Mac download was verified against SHA-256 published by Android Developers.

Installed: JDK 17 (existing), SDK platform/build-tools 36, platform-tools, NDK
28.2.13676358, `aarch64-linux-android`, Android Emulator and AOSP API35 ARM64 image.
The generated CLI template referred to generic API37, which the repository did
not provide at that path; the app uses available stable API36 instead. No runtime
version check was bypassed. Target API36, minimum API24 (Android 7.0).

```sh
export JAVA_HOME='<existing JDK17 home>'
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
npm --prefix clients/tauri run build:gui
npm --prefix clients/tauri run tauri -- android build --debug --target aarch64 --apk --ci
```

Generated project is tracked under `clients/tauri/src-tauri/gen/android`, excluding
build outputs, local paths, JNI library symlinks, per-build context and signing
files. Gradle wrapper version and dependencies are pinned in that project. Use
`npm ci`/Cargo lockfiles for package dependencies. Package ID `dev.pibot.android`;
client version 0.1.0. APK is **debug-signed, debuggable**, not a production release.
The build uses packaged assets with cleartext WebView network access disabled;
native SSH forwards HTTP inside its encrypted session. No production signing key,
Google account or Play Store resource was created.

## Local testing; cloud is optional

Testing does not require cloud Android. This Mac's ARM CPU and Hypervisor.Framework
were verified, and a local Pixel9-profile AOSP Android15/ARM64 emulator was booted.
The emulator/image take several GB; only this task's reproducible compilation
caches were removed to free space. Source, prior Mac/iOS artifacts and test evidence
were preserved. No real device or paid/cloud service was used.

```sh
"$ANDROID_HOME/emulator/emulator" -avd PiBot_API35_arm64 -no-snapshot
"$ANDROID_HOME/platform-tools/adb" -s emulator-5554 install -r path/to/test.apk
```

`10.0.2.2` is the emulator's alias for the host loopback. Functional checks use only
a loopback disposable SSH fixture and dummy daemon, with an ephemeral verified
host key. The app never auto-trusts it. The fixture is external to the APK; no test
profile, password, key or host grant is embedded. The regular UI was used to enter
configuration and enable SSH, not a simulated successful connection. Process
restart was checked to require credential re-entry. Actual device coverage,
persistent Keystore, file-picker private-key import and advanced MFA policies are
not claimed by this first Android package.

Native system-bar insets/dark appearance are applied in MainActivity; the WebView
resizes around the software keyboard. The final verification report and screenshots
are delivered with the APK rather than inferred from a passing compilation alone.

## Verified development package (2026-10-15)

`Pi-Bot-Android-0.1.0-arm64-debug.apk` was built with the installed official
SDK/NDK and installed in the local API35 ARM64 emulator. API24 minimum, target36,
versionCode1000; Android Debug certificate, v2 signature and 16KB zip alignment
verified. SHA256:
`5fde6ec1345a7ad8b53e88379d0287fa2ff80cf9f7990b771b3f42aef91b09c5`.

Actual installed-WebView automation through local ADB/CDP entered the disposable
SSH credentials, loaded conversations, sent messages and received complete replies.
During processing the UI reported `Running · 正在处理`, zero partial reply bubbles,
and viewport scale1. Screenshots capture processing and the final reply. Native
files/WebView persistence and APK contents were scanned for the dummy password;
none was present. Earlier unsuccessful coordinate gestures are not counted as
passing checks. Real Internet hosts, physical devices, Android key import and MFA
remain untested. Shared UI/release checks: 30 passed; GUI and repository typechecks,
iOS release Cargo check and macOS Preview release build also passed.

## Smaller sideload test package (2026-10-15)

The initial 221,587,734-byte APK exceeded chat delivery limits. Inspection found
214,310,032 bytes in the uncompressed native Rust library. The installed NDK
`llvm-strip --strip-debug` and `--strip-unneeded` reduced that library to
24,812,656 bytes, preserving runtime dynamic symbols. Other APK assets/code are
unchanged. Rebuilt ZIP, 16KB zip alignment and signing with the existing Android
Debug test certificate produced `Pi-Bot-Android-0.1.0-arm64-stripped-test.apk`:
**31,630,429 bytes (30.17 MiB)**. This is a stripped **debug/test** package, not
a release-optimized Cargo rebuild or production distribution. No new identity
or production key was created. The original APK remains intact.

SHA256: `4b1ce7474a1caa0df4af0844c95ef53bb2d19fb8c0f316f6a3e87c0f396413a7`.
Signature v2/v3, Android Debug certificate, arm64-v8a, minSdk24/target36 and
16KB zip alignment verified. No dummy password is embedded. Uninstalled the
disposable emulator app and fresh-installed this exact package, configured the
verified dummy SSH fixture using regular UI, loaded history, sent
`Stripped APK native SSH verification` and received its complete fixture reply.
No new Running assertion: the 600ms sample missed that short message's transient
state. Test screenshots/report stay with local artifacts. The Library upload
succeeded as a new file; actual parent chat attachment delivery is a separate step.
