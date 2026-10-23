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
