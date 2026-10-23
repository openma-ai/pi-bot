# iOS TestFlight CI draft

Local draft only. Nothing was pushed/enabled, no GitHub secrets configured, no
private key exported, and no API key created. Existing local signing is separate.

Upstream is openma-ai/pi-bot on GitHub; origin is the user's original local
checkout. No pre-existing .github workflow was present in this checkout.

`.github/workflows/ios-testflight.yml` permits manual workflow_dispatch only, on
the original repository's default branch and first attempt of a run. No PR,
fork, pull_request_target, scheduled or push release trigger is configured.
GitHub token permissions are contents:read, checkout does not persist a token,
and a shared concurrency group prevents simultaneous releases. Re-runs are
blocked to avoid duplicate upload; a fresh manual dispatch obtains a new build.

The separate verification job has no release secrets. Packaging requires the
`testflight` GitHub Environment. Before enabling anything, configure that
Environment to require the user's approval and restrict deployment branches to
the protected default branch. Those remote settings have NOT been changed.
The workflow is not secure to enable with an unprotected environment/branch.

Build IDs start at 2000.0.1 and encode GITHUB_RUN_NUMBER without reuse within
this workflow. This is above the local 1023.x builds of version 0.1.0. Future
manual releases must coordinate the build counter once CI is enabled; do not
recreate the workflow with a reset run counter or re-upload an existing build.

The current project GUI is built into the Rust static library, real pinned
libtailscale is built beforehand, and the prepared Xcode project links that
exact static library. Native iOS minimum is explicit 16.0. AuthenticationServices,
SystemConfiguration and resolv linkage is explicit. Archive verification checks
production bundle/team/version/profile/signature, embedded SDK and absence of
known probe/fixture markers. It never edits archive metadata to claim a signature.

## Approval needed before remote setup

Proposed storage: openma-ai/pi-bot repository, Environment **testflight** only.
Do not put release secrets in fork/PR-visible contexts or a repository file.

| Proposed secret | Purpose and scope |
| --- | --- |
| IOS_DISTRIBUTION_P12_BASE64 | Distribution certificate + private key exported under a separately approved process. This is a new copy of signing access outside the Mac; not done. |
| IOS_DISTRIBUTION_P12_PASSWORD | Password for that encrypted identity package. |
| IOS_APPSTORE_PROFILE_BASE64 | Matching dev.pibot.ios App Store Distribution profile. |
| ASC_PRIVATE_KEY | Apple-issued App Store Connect API .p8 key for unattended upload; creation or reuse requires separate approval. |
| ASC_KEY_ID / ASC_ISSUER_ID | Non-secret identifiers paired with that key, kept in the same Environment. |

Use the minimum Apple role capable of uploading builds (Developer where the
account permits it); confirm actual account/key/app restrictions before issuing
a key. Do not claim a team API key is app-scoped if Apple does not provide that
restriction. No tester invitations, public links, App Store submission or
export-compliance answers are automated here. Existing internal distribution
settings still determine availability after Apple processing.

On a disposable GitHub-hosted macOS runner only, the proposed workflow imports
the approved identity into a new temporary keychain, grants Apple signing tools
access there, and deletes its keychain/files/profile after the job. It does not
modify the user's Mac keychain. This future CI step changes runner signing
access and is NOT executed by preparing these files. Secret values are not
printed; standard Apple security tools do receive secret arguments on the
isolated runner. IPA and non-secret release metadata are retained 7 days; no
keychain, p12, p8, password, full artifact directory or diagnostic logs are uploaded.

`upload=false` exports an IPA without upload; `upload=true` explicitly uploads
to TestFlight only. A local marker is written before uploading, so a failed or
uncertain upload is not automatically retried. Check App Store Connect before
retrying. Upload acceptance is not processing completion or proof of install.

Sources: [GitHub's official signing guide](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)
and [concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency).

## Local validation boundary

Script syntax and generated release project build settings can be verified
without signing or uploading. Current draft was locally checked this way;
the hosted workflow, temporary keychain import, API authentication and upload
have NOT been exercised. Requires a suitable macOS runner with Xcode 26+ and
installed signing material. The current Mac's successful device build is not
proof of a hosted runner release.

## Alternative: Xcode Cloud

Xcode Cloud can avoid exporting the Mac's private signing key to GitHub Actions:
Apple manages cloud signing rather than importing this local p12 into a GitHub
runner. It still needs explicit repository connection and Apple cloud-signing /
workflow authorization. No such access was granted or configured in this task.
The source-based Rust/Node/Go build needs adaptation to Xcode Cloud's custom build
scripts; the existing GitHub YAML is not an Xcode Cloud workflow.

Apple's current public get-started page lists 25 compute hours/month included
with Developer Program membership, and 100 hours at US$49.99/month (larger plans
available). This account's actual subscription and remaining hours were not
checked. Account Holder/Admin/App Manager can configure workflows; other roles
have additional requirements. No extra service account is inherently needed,
but the selected GitHub repository connection needs its owner's authorization.
GitHub Actions runner charges / account minute allowance were not checked.

Sources: https://developer.apple.com/xcode-cloud/get-started/ and
https://developer.apple.com/help/account/certificates/cloud-managed-certificates/ .

### Prepared Xcode Cloud hooks (not enabled)

Apple's documented directory is `ci_scripts` beside the selected Xcode project.
The local hooks are therefore under `clients/tauri/src-tauri/gen/apple/ci_scripts`.
`ci_post_clone.sh` installs only ephemeral build tools and dependencies, runs the
existing checks, builds the pinned userspace SDK and device static library, then
patches that Cloud checkout for automatic signing. `ci_pre_xcodebuild.sh` permits
only Archive of `pi-bot-desktop_iOS`; simulator/test actions fail closed until
separate outputs are implemented. No API key or local private-key export is
needed for Apple's native TestFlight post-action.

These hooks are draft-only: shell syntax, no-op dry runs, read-only transform and
parsed Xcode configuration checks passed locally. No toolchain installation,
actual Cloud build, cloud certificate request, repository connection, remote
workflow creation or upload was performed. Automatic signing and the
TestFlight post-action must be validated by a first explicitly authorized Cloud
run before claiming this path works.

Proposed next confirmation, with no silent expansion:

1. Connect Apple Xcode Cloud only to GitHub repository `openma-ai/pi-bot`.
   The GitHub owner/admin must review Apple's actual GitHub App permission page;
   authorize only this repository, never all organization repositories. If the
   page requires broader access, stop and explain it before proceeding.
2. Use canonical project `clients/tauri/src-tauri/gen/apple/pi-bot-desktop.xcodeproj`,
   scheme `pi-bot-desktop_iOS`, Team `962863MJ5J`, app `dev.pibot.ios` /
   App Store Connect app `6823234702`. Selected source is the default protected
   branch; actual remote branch protection has not been audited/configured.
3. Manual starts only. Disable initial commit/PR/tag/schedule automatic start
   conditions. Archive iOS only; no external tester invitations or App Store
   submission. The TestFlight post-action targets the existing Pibo Personal
   Test internal group, without changing its audience.
4. Set the initial Cloud build counter to **3000**, above the existing local
   1023.x candidate, and keep Apple's counter monotonic. Hook guards reject
   counters below 1024 or above 9999; allocate a new marketing version before
   rollover. The first run must confirm Apple's emitted build number before
   distribution. Choose one pipeline/counter owner; don't independently release
   conflicting numbers from the GitHub draft.
5. Explicitly permit Apple to manage the app's cloud signing certificates and
   provisioning profiles for that workflow, without exporting existing Mac
   keys, revoking existing identities or changing Mac Keychain permissions.
   The Apple account's actual eligible role and account agreements must be
   checked during setup; any new agreement/paid subscription needs user action.

References: https://developer.apple.com/documentation/xcode/writing-custom-build-scripts
and https://developer.apple.com/documentation/xcode/environment-variable-reference .

## Preferred current option: manual local pipeline

Use the existing Mac and Apple Developer account; no additional cloud CI fee,
self-hosted runner, background service or new credential storage is introduced.
Xcode Cloud and GitHub drafts remain disabled. The existing Mac Keychain may
still require approval for each signing use; local automation cannot remove that
requirement without a separate security change, which this implementation does
not make.

```sh
# Safe plan only; does not build, sign, login or upload.
bash clients/tauri/scripts/local-ios-release.sh --build 1023.7.2 --upload --dry-run
# After the current release has finished, choose a confirmed new unused build:
bash clients/tauri/scripts/local-ios-release.sh --build NEW.BUILD.NUMBER --upload
```

Without `--upload`, the pipeline stops at the exported IPA. `--rebuild-sdk` is
optional and explicitly rebuilds the pinned real userspace archive; otherwise
it requires the already built project-local archive. No Tailnet node is started.
The pipeline checks active Pibo xcodebuild processes and a local atomic lock,
then runs TypeScript/tests/GUI lint, device Release, archive audit, export and
optional upload. Existing build output is never overwritten. Failed or uncertain
uploads are not retried automatically. The granular `ios-testflight.sh` stages
remain available for deliberate continuation after inspecting a saved result.

The wrapper refuses offline SDK stubs, uses the existing Xcode account and
Distribution profile, and does not import identities or adjust Keychain access.
An expired account login or system password prompt is handled by the user.
Apple processing/compliance/internal group readiness is a distinct later check;
a zero upload exit is not labeled installable. The running 1023.7.1 archive is
preserved and was not restarted to test this wrapper.
