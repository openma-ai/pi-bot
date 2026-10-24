#!/bin/bash
# Explicit local/CI stages. Never creates signing identities or modifies Keychain.
set -euo pipefail
stage=${1:?Use build, archive, export or upload}
build=${PIBO_IOS_BUILD:?Set a unique Apple-compatible build number}
root=$(cd "$(dirname "$0")/../../.." && pwd)
output=${PIBO_IOS_OUTPUT:-"$root/artifacts/ios-$build"}
project="$root/clients/tauri/src-tauri/gen/apple/pibo-release-ci.xcodeproj"
cd "$root"
case "$stage" in
 build)
  npm --prefix clients/tauri run build:gui
  export IPHONEOS_DEPLOYMENT_TARGET=16.0
  export TAURI_CONFIG
  TAURI_CONFIG=$(python3 -c 'import json,sys;print(json.dumps({"identifier":"dev.pibot.ios","productName":"Pibo","bundle":{"iOS":{"minimumSystemVersion":"16.0","bundleVersion":sys.argv[1]}}}))' "$build")
  cargo build --manifest-path clients/tauri/src-tauri/Cargo.toml --release --target aarch64-apple-ios --features embedded-tailscale,custom-protocol
  python3 clients/tauri/scripts/prepare-ios-release.py --build "$build" --output "$output"
  ;;
 archive)
  test -f "$output/release.json"
  xcodebuild -project "$project" -scheme pi-bot-desktop_iOS -configuration release -sdk iphoneos -destination generic/platform=iOS -archivePath "$output/Pibo.xcarchive" -derivedDataPath "$output/derived" archive
  ;;
 export|upload)
  test -d "$output/Pibo.xcarchive"
  auth=()
  if [[ -n ${ASC_KEY_PATH:-} ]]; then auth=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "${ASC_KEY_ID:?}" -authenticationKeyIssuerID "${ASC_ISSUER_ID:?}"); fi
  if [[ $stage == upload ]]; then
   [[ ${PIBO_CONFIRM_TESTFLIGHT_UPLOAD:-} == YES ]] || { echo 'Explicit TestFlight upload confirmation is required'; exit 2; }
   mkdir "$output/upload-started" 2>/dev/null || { echo 'Upload already started; inspect Apple status before any retry'; exit 2; }
   options="$output/UploadOptions.plist"
  else options="$output/ExportOptions.plist"; fi
  xcodebuild -exportArchive -archivePath "$output/Pibo.xcarchive" -exportPath "$output/$stage" -exportOptionsPlist "$options" ${auth[@]+"${auth[@]}"}
  ;;
 *) echo 'Use build, archive, export or upload'; exit 2;;
esac
