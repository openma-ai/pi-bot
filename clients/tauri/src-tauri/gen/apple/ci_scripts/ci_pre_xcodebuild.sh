#!/bin/bash
set -euo pipefail
if [[ ${PIBO_CLOUD_DRY_RUN:-} == 1 ]]; then echo 'Plan: require Archive/iOS production scheme and prepared static library. No build/sign/upload executed.'; exit 0; fi
[[ ${CI_XCODE_CLOUD:-} == TRUE ]] || { echo 'Xcode Cloud context required'; exit 2; }
[[ ${CI_XCODEBUILD_ACTION:-} == archive && ${CI_XCODE_SCHEME:-} == pi-bot-desktop_iOS ]] || { echo 'This first workflow supports Archive only; simulator/test actions need separate SDK outputs'; exit 2; }
root=${CI_PRIMARY_REPOSITORY_PATH:?}
test -s "$root/clients/tauri/src-tauri/gen/apple/Externals/arm64/release/libapp.a"
test -f "$root/clients/tauri/src-tauri/gen/apple/ci_scripts/.pibo-cloud-prepared"
# Apple runs xcodebuild and manages signing/distribution after this hook.
