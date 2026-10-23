#!/usr/bin/env python3
"""Prepare an adjacent Xcode project from current sources; never signs or uploads."""
import argparse,json,plistlib,re,shutil,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--build',required=True);p.add_argument('--output',required=True);a=p.parse_args()
if not re.fullmatch(r'[1-9][0-9]{0,3}\.[0-9]{1,2}\.[0-9]{1,2}',a.build):p.error('Build must be major(1..9999).minor(0..99).patch(0..99)')
root=Path(__file__).resolve().parents[3];out=Path(a.output).resolve();out.mkdir(parents=True,exist_ok=True)
apple=root/'clients/tauri/src-tauri/gen/apple';project=apple/'pibo-release-ci.xcodeproj'
if project.exists():shutil.rmtree(project) # exclusively this generated project, never a source project
shutil.copytree(apple/'pi-bot-desktop.xcodeproj',project,ignore=shutil.ignore_patterns('xcuserdata'))
for scheme in (project/'xcshareddata/xcschemes').glob('*.xcscheme'):
    scheme.write_text(scheme.read_text().replace('container:pi-bot-desktop.xcodeproj','container:pibo-release-ci.xcodeproj'))
info=plistlib.loads((apple/'pi-bot-desktop_iOS/Info.plist').read_bytes());info['CFBundleVersion']=a.build;info['CFBundleShortVersionString']='0.1.0';(out/'Info.plist').write_bytes(plistlib.dumps(info))
link=out/'link';link.mkdir(exist_ok=True);lib=link/'libapp.a'
if lib.is_symlink():lib.unlink()
if lib.exists():raise SystemExit('Refusing to replace a non-symlink release library')
lib.symlink_to(root/'clients/tauri/src-tauri/target/aarch64-apple-ios/release/libpi_bot_desktop.a')
pbx=project/'project.pbxproj';s=pbx.read_text();s=re.sub(r'^\s*[A-F0-9]+ /\* Build Rust Code \*/,\n','',s,flags=re.M)
s=s.replace('path = libapp.a; sourceTree = "<group>";',f'path = "{lib}"; sourceTree = "<absolute>";')
s=s.replace('INFOPLIST_FILE = "pi-bot-desktop_iOS/Info.plist";',f'INFOPLIST_FILE = "{out}/Info.plist";')
s=re.sub(r'("LIBRARY_SEARCH_PATHS\[arch=arm64\]" = )"[^"\n]*";',lambda m:m[1]+f'"{link} $(inherited) $(SDKROOT)/usr/lib/swift $(DEVELOPER_DIR)/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/$(PLATFORM_NAME)";',s)
pbx.write_text(s)
opts={'method':'app-store-connect','teamID':'962863MJ5J','signingStyle':'manual','provisioningProfiles':{'dev.pibot.ios':'Pibo App Store Distribution'},'signingCertificate':'Apple Distribution','manageAppVersionAndBuildNumber':False,'uploadSymbols':True,'testFlightInternalTestingOnly':True}
for destination in ['export','upload']:(out/(destination.title()+'Options.plist')).write_bytes(plistlib.dumps({**opts,'destination':destination}))
(out/'release.json').write_text(json.dumps({'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'bundle':'dev.pibot.ios','team':'962863MJ5J','version':'0.1.0','build':a.build,'project':str(project)},indent=2))
print(project)
