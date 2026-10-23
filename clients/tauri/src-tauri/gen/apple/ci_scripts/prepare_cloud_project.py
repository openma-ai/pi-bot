#!/usr/bin/env python3
"""Patch only the authorized ephemeral Cloud checkout; --check never writes."""
import argparse,json,os,plistlib,re,shutil
from pathlib import Path

def patch(text):
    text=re.sub(r'^\s*[A-F0-9]+ /\* Build Rust Code \*/,\n','',text,flags=re.M)
    text=text.replace('CODE_SIGN_STYLE = Manual;','CODE_SIGN_STYLE = Automatic;')
    text=re.sub(r'^\s*PROVISIONING_PROFILE_SPECIFIER = [^;]+;\n','',text,flags=re.M)
    text=re.sub(r'^\s*CODE_SIGN_IDENTITY = "Apple Distribution";\n','',text,flags=re.M)
    return text

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--build',required=True);g=p.add_mutually_exclusive_group(required=True);g.add_argument('--apply',action='store_true');g.add_argument('--check',action='store_true');a=p.parse_args()
    if not a.build.isdecimal() or not 1024<=int(a.build)<=9999:p.error('Cloud build counter must be 1024..9999; configure the initial build as 3000')
    root=Path(a.root).resolve();apple=root/'clients/tauri/src-tauri/gen/apple';project=apple/'pi-bot-desktop.xcodeproj/project.pbxproj';text=patch(project.read_text())
    assert 'PRODUCT_BUNDLE_IDENTIFIER = dev.pibot.ios;' in text
    assert 'DEVELOPMENT_TEAM = 962863MJ5J;' in text
    assert 'CODE_SIGN_STYLE = Manual;' not in text
    assert 'PROVISIONING_PROFILE_SPECIFIER' not in text
    assert 'AuthenticationServices' in text
    if a.apply:
        if os.environ.get('CI_XCODE_CLOUD')!='TRUE' or root!=Path(os.environ.get('CI_PRIMARY_REPOSITORY_PATH','/nonexistent')).resolve():p.error('Apply is restricted to the actual authorized Cloud checkout')
        lib=root/'clients/tauri/src-tauri/target/aarch64-apple-ios/release/libpi_bot_desktop.a';assert lib.is_file()
        target=apple/'Externals/arm64/release/libapp.a';target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(lib,target)
        info=apple/'pi-bot-desktop_iOS/Info.plist';v=plistlib.loads(info.read_bytes());v['CFBundleVersion']=str(int(a.build));info.write_bytes(plistlib.dumps(v))
        project.write_text(text);(apple/'ci_scripts/.pibo-cloud-prepared').write_text(a.build)
    print(json.dumps({'mode':'applied' if a.apply else 'read-only-check','build':a.build,'bundle':'dev.pibot.ios','team':'962863MJ5J','automaticSigning':True,'privateKeyExport':False}))
