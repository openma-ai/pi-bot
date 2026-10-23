#!/bin/bash
# Xcode Cloud only. This file does not connect a repository or authorize signing.
set -euo pipefail
if [[ ${PIBO_CLOUD_DRY_RUN:-} == 1 ]]; then
 echo 'Plan: ephemeral Node24/Rust1.97.1/Go setup; npm checks; pinned userspace SDK; device static library; automatic-signing project settings. No commands executed.'
 exit 0
fi
[[ ${CI_XCODE_CLOUD:-} == TRUE ]] || { echo 'Run only inside an explicitly authorized Xcode Cloud workflow'; exit 2; }
root=${CI_PRIMARY_REPOSITORY_PATH:?Missing Apple repository path}
number=${CI_BUILD_NUMBER:?Missing Apple build counter}
# Configure the first Cloud build as 3000 before enabling distribution.
[[ $number =~ ^[1-9][0-9]{0,3}$ && $number -ge 1024 ]] || { echo 'Cloud build must be 1024..9999 and above existing TestFlight builds'; exit 2; }
cd "$root"
export HOMEBREW_NO_AUTO_UPDATE=1
command -v brew >/dev/null || { echo 'This Cloud image needs Homebrew available'; exit 2; }
if ! command -v node >/dev/null || [[ $(node -p 'process.versions.node.split(".")[0]') != 24 ]]; then brew install node@24; fi
export PATH="$(brew --prefix node@24 2>/dev/null)/bin:$PATH"
if ! command -v rustup >/dev/null; then brew install rustup; export PATH="$(brew --prefix rustup)/bin:$PATH"; fi
if ! command -v go >/dev/null; then brew install go; fi
export PATH="$HOME/.cargo/bin:$PATH"
rustup toolchain install 1.97.1 --profile minimal
rustup default 1.97.1
rustup target add aarch64-apple-ios
npm ci
npm --prefix clients/tauri ci
npm run check
npm test
npm run gui:check
sh clients/tauri/scripts/build-embedded-tailscale.sh ios
npm --prefix clients/tauri run build:gui
export IPHONEOS_DEPLOYMENT_TARGET=16.0
export TAURI_CONFIG
TAURI_CONFIG=$(python3 -c 'import json,sys;print(json.dumps({"identifier":"dev.pibot.ios","productName":"Pibo","bundle":{"iOS":{"minimumSystemVersion":"16.0","bundleVersion":sys.argv[1]}}}))' "$number")
cargo build --manifest-path clients/tauri/src-tauri/Cargo.toml --release --target aarch64-apple-ios --features embedded-tailscale,custom-protocol
python3 clients/tauri/src-tauri/gen/apple/ci_scripts/prepare_cloud_project.py --root "$root" --build "$number" --apply
