#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
platform=${1:-macos}
mkdir -p build/module-cache
case "$platform" in
  macos) sdk=macosx; target=arm64-apple-macos14.0 ;;
  ios-simulator) sdk=iphonesimulator; target=arm64-apple-ios17.0-simulator ;;
  ios-device) sdk=iphoneos; target=arm64-apple-ios17.0 ;;
  *) echo "Usage: bash scripts/build.sh [macos|ios-simulator|ios-device]"; exit 2 ;;
esac
app="build/$platform/PiBot.app"
mkdir -p "$app"
if [ "$platform" = macos ]; then
  executable="$app/Contents/MacOS/PiBot"
  plist="$app/Contents/Info.plist"
  mkdir -p "$app/Contents/MacOS"
else
  executable="$app/PiBot"
  plist="$app/Info.plist"
fi
xcrun --sdk "$sdk" swiftc -parse-as-library -sdk "$(xcrun --sdk "$sdk" --show-sdk-path)" -target "$target" -module-cache-path "$PWD/build/module-cache" Sources/*.swift -o "$executable"
cat > "$plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>PiBot</string>
<key>CFBundleIdentifier</key><string>dev.pibot.client</string>
<key>CFBundleName</key><string>Pi Bot</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>MinimumOSVersion</key><string>17.0</string>
<key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
<key>UILaunchScreen</key><dict/>
<key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationPortrait</string><string>UIInterfaceOrientationLandscapeLeft</string><string>UIInterfaceOrientationLandscapeRight</string></array>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
if [ "$platform" != ios-device ]; then /usr/bin/codesign --force --sign - "$app"; fi
echo "$PWD/$app"
