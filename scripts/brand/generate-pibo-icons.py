#!/usr/bin/env python3
"""Resize the approved raster only; use Apple's sips/iconutil, no redraw or recoloring."""
import hashlib,json,struct,subprocess,tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[2]
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
for name,size in [('icon.png',1024),('32x32.png',32),('128x128.png',128),('128x128@2x.png',256)]:resize(icons/name,size)
resize(root/'src/gui/assets/pibo-logo.png',256)
manifest=json.loads((catalog/'Contents.json').read_text())
for image in manifest['images']:
 size=float(image['size'].split('x')[0]);scale=float(image['scale'][:-1]);resize(catalog/image['filename'],int(size*scale))
with tempfile.TemporaryDirectory(prefix='pibo-icon-') as d:
 iconset=Path(d)/'Pibo.iconset';iconset.mkdir()
 for size in [16,32,128,256,512]:
  resize(iconset/f'icon_{size}x{size}.png',size)
  resize(iconset/f'icon_{size}x{size}@2x.png',size*2)
 subprocess.run(['iconutil','-c','icns',str(iconset),'-o',str(icons/'icon.icns')],check=True)
metadata={'library_file_id':'libfile_cae2cb5f50888191a7232fa5b60af9e7','source':'pibo-approved-source.png','sourceSHA256':hashlib.sha256(source.read_bytes()).hexdigest(),'sourcePixels':[w,h],'operations':'proportional resizing only; opaque RGB preserved; no crop, redraw, recolor, or eye cutouts','iosCatalogSlots':len(manifest['images']),'tools':['Apple sips','Apple iconutil']}
(root/'assets/brand/provenance.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(metadata,ensure_ascii=False))
