"""Additional startup and desktop checks; uses the same isolated browser fixture."""
import subprocess,json,time
from pathlib import Path
out=Path('artifacts/astra');checks=[]
def ab(*args):
 r=subprocess.run(['agent-browser','--session','pibo-astra','--json',*args],capture_output=True,text=True,check=True);data=json.loads(r.stdout)
 assert data['success'],data
 return data['data']
def js(code):return ab('eval',code).get('result')
def check(name,value):
 checks.append({'check':name,'pass':bool(value)});(out/'browser-extra-checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2));assert value,name
def shot(name):ab('screenshot',str(out/name))
def click(name):ab('find','role','button','click','--name',name);time.sleep(.3)
def openq(q):ab('open','http://127.0.0.1:5193/clients/tauri/test/ui/index.html?'+q);time.sleep(.3)
ab('set','viewport','393','852');openq('phone=1&returning=1&restore=1&slow=1&success=1');shot('19-restoring.png');click('连接设置');click('取消连接');click('关闭设置');time.sleep(5.2)
check('Cancelled restore stays disconnected after late response',js('window.__PIBO_TEST__.active===null'))
check('Cancelled restore keeps conversation navigation',js('!!document.querySelector(".app")'))
click('连接设置');time.sleep(.3);shot('20-connection-configure.png')
# Desktop mode, including simulated Mac overlay titlebar.
ab('set','viewport','1280','900');openq('mac=1&connected=1&models=1&story=1');ab('click','[aria-label="灵感搭子 · 演示"]');time.sleep(.3)
js('window.__qaMainBefore=document.querySelector(".main").getBoundingClientRect().toJSON()');shot('21-desktop-chat.png');click('打开会话详情')
check('Desktop details overlay does not resize or shift chat',js('JSON.stringify(window.__qaMainBefore)===JSON.stringify(document.querySelector(".main").getBoundingClientRect().toJSON())'))
check('Desktop titlebar and composer remain in viewport',js('document.querySelector(".header").getBoundingClientRect().top===0 && document.querySelector(".composer-shell").getBoundingClientRect().bottom<=innerHeight'))
shot('22-desktop-details.png')
# Use the sidebar settings control; details can stay underneath the dialog.
click('设置');shot('23-desktop-models.png')
check('Desktop settings bounded',js('document.querySelector("[role=dialog]").getBoundingClientRect().bottom<=innerHeight'))
print(json.dumps({'passed':len(checks),'checks':checks},ensure_ascii=False,indent=2))
