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
