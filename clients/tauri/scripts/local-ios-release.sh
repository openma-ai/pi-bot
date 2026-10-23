#!/bin/bash
# Manual local pipeline; no runner, daemon, Keychain configuration or new login.
set -euo pipefail
build=; upload=0; dry=0; rebuild=0
while [[ $# -gt 0 ]]; do
 case "$1" in
  --build) build=${2:?Missing build}; shift 2;;
  --upload) upload=1; shift;;
  --dry-run) dry=1; shift;;
  --rebuild-sdk) rebuild=1; shift;;
  *) echo 'Use --build N.N.N [--upload] [--dry-run] [--rebuild-sdk]'; exit 2;;
 esac
done
[[ $build =~ ^[1-9][0-9]{0,3}\.[0-9]{1,2}\.[0-9]{1,2}$ ]] || { echo 'Choose a new major.minor.patch build'; exit 2; }
root=$(cd "$(dirname "$0")/../../.." && pwd)
export PIBO_IOS_BUILD="$build"
export PIBO_IOS_OUTPUT="$root/artifacts/ios-$build"
export PIBO_TAILSCALE_LIB_DIR="$root/clients/tauri/.tailscale-build/ios"
cd "$root"
plan(){
 echo '1. Check no active Pibo archive/export; take a local process lock'
 echo '2. TypeScript, all synthetic tests, GUI lint'
 if [[ $rebuild == 1 ]];then echo '3. Rebuild pinned real iOS userspace SDK (no node login)';else echo '3. Require/reuse existing real project-local iOS SDK archive';fi
 echo "4. Build current GUI + real device Release; prepare dev.pibot.ios $build"
 echo '5. Archive with existing Distribution identity/profile (system may require approval)'
 echo '6. Read-only signature/profile/SDK/probe audit; export IPA'
 if [[ $upload == 1 ]];then echo '7. Upload once to TestFlight using existing Xcode account; never App Store submission';else echo '7. Stop after IPA export (no upload)';fi
}
if [[ $dry == 1 ]];then plan;exit 0;fi
[[ $(uname -s) == Darwin ]] || { echo 'Requires existing macOS/Xcode';exit 2; }
[[ ${PIBO_TAILSCALE_OFFLINE_TEST:-0} != 1 ]] || { echo 'Refusing release with offline SDK stubs';exit 2; }
python3 - "$root" <<'PY'
import subprocess,sys
root=sys.argv[1]
for line in subprocess.check_output(['ps','-axo','pid=,comm=,args='],text=True).splitlines():
 parts=line.strip().split(None,2)
 if len(parts)<3:continue
 pid,comm,args=parts
 if comm.rsplit('/',1)[-1]!='xcodebuild':continue
 if 'pibo-testflight.xcodeproj' in args or 'pibo-release-ci.xcodeproj' in args or (root in args and '-exportArchive' in args):
  raise SystemExit('Existing Pibo xcodebuild PID '+pid+' is active; preserve it, do not start another release')
PY
git diff --quiet HEAD -- || { echo 'Tracked changes need review before release';exit 2; }
[[ ! -e "$PIBO_IOS_OUTPUT" ]] || { echo 'Build output already exists; inspect/resume individual stages rather than overwrite or re-upload';exit 2; }
mkdir -p artifacts
lock="$root/artifacts/.pibo-ios-release-lock"
mkdir "$lock" 2>/dev/null || { echo 'Another local pipeline lock exists; inspect its PID before proceeding';exit 2; }
printf '%s\n' "$$" > "$lock/pid"
trap 'rm -f "$lock/pid"; rmdir "$lock"' EXIT
# This wrapper reuses the existing interactive Xcode account, never an ambient API key.
unset ASC_KEY_PATH ASC_KEY_ID ASC_ISSUER_ID
npm run check
npm test
npm run gui:check
if [[ $rebuild == 1 ]];then sh clients/tauri/scripts/build-embedded-tailscale.sh ios;fi
test -s "$PIBO_TAILSCALE_LIB_DIR/libtailscale.a" || { echo 'Real SDK archive missing; use the explicit --rebuild-sdk option';exit 2; }
bash clients/tauri/scripts/ios-testflight.sh build
bash clients/tauri/scripts/ios-testflight.sh archive
python3 clients/tauri/scripts/verify-ios-archive.py "$PIBO_IOS_OUTPUT/Pibo.xcarchive" --build "$build" > "$PIBO_IOS_OUTPUT/archive-audit.json"
bash clients/tauri/scripts/ios-testflight.sh export
if [[ $upload == 1 ]];then
 export PIBO_CONFIRM_TESTFLIGHT_UPLOAD=YES
 bash clients/tauri/scripts/ios-testflight.sh upload
 echo 'Upload command completed. Confirm Apple processing and existing internal-group availability separately.'
fi
