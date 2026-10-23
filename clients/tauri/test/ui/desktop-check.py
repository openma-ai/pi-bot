import subprocess,json
from pathlib import Path
Path('artifacts/desktop-toolbar').mkdir(parents=True,exist_ok=True)
base=['agent-browser','--session','pibo-toolbar']
def run(*args):return subprocess.check_output(base+list(args),text=True)
js='''JSON.stringify({w:innerWidth,h:innerHeight,dialog:document.querySelector('.computer-fullscreen').getBoundingClientRect().toJSON(),toolbar:document.querySelector('.desktop-controls').getBoundingClientRect().toJSON(),stage:document.querySelector('.vnc-stage').getBoundingClientRect().toJSON(),items:[...document.querySelectorAll('.desktop-status,.desktop-actions button')].map(e=>({text:e.textContent,box:e.getBoundingClientRect().toJSON()}))})'''
results=[]
for name,w,h in [('portrait',402,874),('landscape',874,402),('narrow',320,568),('keyboard-viewport',402,390),('landscape-keyboard-viewport',874,250)]:
 if 'keyboard' in name:
  run('set','viewport','402','874')
  run('fill','[aria-label="模拟键盘输入"]','布局验证')
 run('set','viewport',str(w),str(h))
 d=json.loads(run('eval',js))
 if isinstance(d,str):d=json.loads(d)
 assert d['dialog']['bottom']<=h+.5,(name,d)
 assert d['dialog']['top']>=-.5,(name,d)
 assert all(abs(i['box']['height']-44)<.5 for i in d['items'][1:]),(name,d)
 buttons=d['items'][1:]
 assert abs(buttons[0]['box']['y']-buttons[1]['box']['y'])<.5,(name,d)
 assert all(i['box']['right']<=w+.5 for i in d['items']),(name,d)
 if w>360:assert abs(d['items'][0]['box']['y']-buttons[0]['box']['y'])<.5,(name,d)
 run('screenshot','artifacts/desktop-toolbar/after-'+name+'.png')
 results.append({'case':name,'passed':True,**d})
Path('artifacts/desktop-toolbar/layout-checks.json').write_text(json.dumps(results,indent=2))
print(json.dumps([{'case':d['case'],'passed':d['passed'],'buttonHeights':[i['box']['height']for i in d['items'][1:]],'dialogBottom':d['dialog']['bottom']}for d in results]))
