#!/usr/bin/env python3
"""Resize the approved raster only; use Apple's sips/iconutil, no redraw or recoloring."""
import argparse,hashlib,json,struct,subprocess,tempfile,shutil
from pathlib import Path
root=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser();parser.add_argument('--tauri-cli',type=Path,default=root/'clients/tauri/node_modules/.bin/tauri');args=parser.parse_args()
source=root/'assets/brand/pibo-approved-source.png'
icons=root/'clients/tauri/src-tauri/icons'
catalog=root/'clients/tauri/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset'
def png_info(p):
 b=p.read_bytes();assert b[:8]==b'\x89PNG\r\n\x1a\n';w,h,depth,color=struct.unpack('>IIBB',b[16:26]);return w,h,depth,color
w,h,_,color=png_info(source)
assert w==h and color==2,'Approved source must be square RGB PNG without alpha'
def resize(p,size):
 p.parent.mkdir(parents=True,exist_ok=True)
 subprocess.run(['sips','-s','format','png','-z',str(size),str(size),str(source),'--out',str(p)],stdout=subprocess.DEVNULL,check=True)
 assert png_info(p)[:2]==(size,size)
 assert png_info(p)[3]==2,'App icons must remain opaque RGB'
icons.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='pibo-tauri-icon-') as d:
 subprocess.run([str(args.tauri_cli),'icon',str(source),'--output',d,'-p','32','-p','128','-p','256','-p','1024'],check=True)
 for name,size in [('icon.png',1024),('32x32.png',32),('128x128.png',128),('128x128@2x.png',256)]:
  shutil.copyfile(Path(d)/f'{size}x{size}.png',icons/name)
  assert png_info(icons/name)[3]==6,'Tauri window icons require RGBA'
resize(root/'src/gui/assets/pibo-logo.png',256)
manifest=json.loads((catalog/'Contents.json').read_text())
for image in manifest['images']:
 size=float(image['size'].split('x')[0]);scale=float(image['scale'][:-1]);resize(catalog/image['filename'],int(size*scale))
subprocess.run(['swift',str(root/'scripts/brand/macos-icon.swift'),str(source),str(icons/'macos-icon.png')],check=True)
with tempfile.TemporaryDirectory(prefix='pibo-icon-') as d:
 iconset=Path(d)/'Pibo.iconset';iconset.mkdir()
 for size in [16,32,128,256,512]:
  for scale in [1,2]:
   target=iconset/(f'icon_{size}x{size}'+('@2x' if scale==2 else '')+'.png')
   subprocess.run(['sips','-z',str(size*scale),str(size*scale),str(icons/'macos-icon.png'),'--out',str(target)],stdout=subprocess.DEVNULL,check=True)
 subprocess.run(['iconutil','-c','icns',str(iconset),'-o',str(icons/'icon.icns')],check=True)
metadata={'library_file_id':'libfile_cae2cb5f50888191a7232fa5b60af9e7','source':'pibo-approved-source.png','sourceSHA256':hashlib.sha256(source.read_bytes()).hexdigest(),'sourcePixels':[w,h],'operations':'approved mark resized proportionally without redraw or recolor; iOS remains opaque; macOS uses a transparent inset rounded container','iosCatalogSlots':len(manifest['images']),'desktopFormat':'macOS ICNS has transparent padding and rounded corners; Tauri window PNGs remain RGBA','tools':['Apple sips','Apple iconutil','Apple AppKit','Tauri icon']}
prior=json.loads((root/'assets/brand/provenance.json').read_text())
if 'macOSPackaging' in prior:metadata['macOSPackaging']=prior['macOSPackaging']
(root/'assets/brand/provenance.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(metadata,ensure_ascii=False))
