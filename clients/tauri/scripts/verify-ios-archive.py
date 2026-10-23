#!/usr/bin/env python3
"""Read-only release audit; does not use a signing key or make network requests."""
import argparse,json,plistlib,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('archive');p.add_argument('--build',required=True);a=p.parse_args()
archive=Path(a.archive);apps=list((archive/'Products/Applications').glob('*.app'))
assert len(apps)==1,'Expected one application'
app=apps[0];info=plistlib.loads((app/'Info.plist').read_bytes());meta=plistlib.loads((archive/'Info.plist').read_bytes())
assert info['CFBundleIdentifier']=='dev.pibot.ios'
assert info['CFBundleShortVersionString']=='0.1.0' and info['CFBundleVersion']==a.build
assert meta['ApplicationProperties']['Team']=='962863MJ5J'
subprocess.run(['/usr/bin/codesign','--verify','--deep','--strict',str(app)],check=True)
profile=plistlib.loads(subprocess.check_output(['/usr/bin/security','cms','-D','-i',str(app/'embedded.mobileprovision')],stderr=subprocess.DEVNULL))
assert profile['Entitlements']['application-identifier']=='962863MJ5J.dev.pibot.ios'
assert profile['Entitlements'].get('get-task-allow',False) is False
binary=(app/info['CFBundleExecutable']).read_bytes()
for marker in [b'PIBO_DIRECT_TEST',b'dev.pibot.direct-simulator',b'100.127.171.114',b'100.65.80.34',b'OFFLINE LAYOUT FIXTURE',b'pibo-ios-simulator-test']:
 assert marker not in binary,'Test-only marker in release executable: '+marker.decode()
assert b'tailscale.com/tsnet' in binary,'Embedded userspace SDK marker missing'
print(json.dumps({'bundle':info['CFBundleIdentifier'],'version':info['CFBundleShortVersionString'],'build':a.build,'team':'962863MJ5J','signatureVerified':True,'profileUUID':profile['UUID'],'embeddedSDK':True,'testMarkersAbsent':True}))
