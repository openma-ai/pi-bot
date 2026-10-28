"""Browser UI only; synthetic transport flags, no model/auth/network provisioning."""
import json, subprocess, time
from pathlib import Path
out=Path('artifacts/harness-landing');out.mkdir(parents=True,exist_ok=True)
checks=[]
def ab(*args):
 r=subprocess.run(['agent-browser','--session','pibo-harness-qa','--json',*args],capture_output=True,text=True,timeout=25)
 if r.returncode:raise RuntimeError(r.stderr or r.stdout)
 d=json.loads(r.stdout);assert d['success'],d;return d.get('data',{})
def js(c):return ab('eval',c).get('result')
def check(name,ok):
 checks.append({'check':name,'pass':bool(ok)});(out/'checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2));assert ok,name;print('PASS '+name,flush=True)
def click(name):
 try:ab('find','role','button','click','--name',name)
 except RuntimeError:
  # iOS pointer-up closes the modal before the automation's click acknowledgement.
  if name!='关闭设置' or js('!!document.querySelector(\"[role=dialog]\")'):raise
 time.sleep(.2)
def openq(q):
 ab('open','http://127.0.0.1:5193/clients/tauri/test/ui/index.html?'+q);ab('wait','.app');time.sleep(.6)
def shot(name):ab('screenshot',str(out/name))
ab('set','viewport','1280','800');openq('builtin=1&mac=1')
check('Desktop offers local start without auto-start',js('!!document.querySelector(".connection-start")&&window.__PIBO_TEST__.connectAttempts===0'))
check('First connection is compact inside chat',js('document.querySelector(".connection-start").getBoundingClientRect().height<240&&!document.querySelector(".connection-landing")'))
shot('02-desktop-first-connection-qa.png')
click('连接远端');click('添加连接')
check('Native offers HTTP(S), SDK and separate independent local service',js('document.body.textContent.includes("HTTP(S) 地址")&&document.body.textContent.includes("Tailscale")&&document.body.textContent.includes("独立本机服务")'))
click('取消并返回');click('关闭设置')
check('Cancel returns to first connection choices',js('!!document.querySelector(".connection-start")&&!document.querySelector("[role=dialog]")'))
js('(()=>{const b=[...document.querySelectorAll("button")].find(e=>e.textContent.includes("在本机开始"));b.click();b.click()})()');time.sleep(1.8)
check('Duplicate start makes one attempt',js('window.__PIBO_TEST__.connectAttempts===1'))
check('Start failure uses compact status and Settings only',js('!document.querySelector(".connection-start")&&document.querySelector(".connection-feedback").textContent==="连接失败·设置"'))
time.sleep(2.2);check('Failed start never loops',js('window.__PIBO_TEST__.connectAttempts===1'))
click('连接设置');check('Settings shows builtin entry and no unavailable download card',js('document.body.textContent.includes("内置运行")&&!document.body.textContent.includes("运行环境安装状态")'))
click('管理 本机 · 测试状态');check('Protected builtin cannot be edited or removed',js('![...document.querySelectorAll("[role=menuitem]")].some(e=>/编辑|移除连接/.test(e.textContent))'));ab('press','Escape');click('关闭设置')
openq('builtin=1&mac=1&unavailable=1');check('Missing bundled resource cannot pretend to start',js('[...document.querySelectorAll("button")].find(e=>e.textContent.includes("在本机开始")).disabled&&document.body.textContent.includes("未找到内置运行组件")'))
for w,h in [(393,852),(320,568),(874,402)]:
 ab('set','viewport',str(w),str(h));openq('phone=1&builtin=1')
 check(f'Phone has remote entry only at {w}x{h}',js('!!document.querySelector(".connection-start")&&!document.body.textContent.includes("在本机开始")&&document.documentElement.scrollWidth<=innerWidth'))
 check(f'Phone action has visible accent background at {w}x{h}',js('getComputedStyle(document.querySelector(\".connection-start-actions button\")).backgroundColor===\"rgb(199, 72, 51)\"'))
 click('前往连接设置');click('添加连接')
 check(f'Phone excludes local service form at {w}x{h}',js('!document.body.textContent.includes("独立本机服务")'))
 click('取消并返回');click('关闭设置')
 if w==393:shot('03-phone-first-connection-qa.png')
 if w==874:shot('04-phone-landscape-qa.png')
ab('set','viewport','1280','800');openq('builtin=1&mac=1&success=1');click('在本机开始');time.sleep(2)
check('Successful start enters workspace and leaves first connection',js('window.__PIBO_TEST__.active?.profileId==="builtin"&&!document.querySelector(".connection-start")'))
check('No user auth was started by landing',js('!window.__PIBO_TEST__.nativeCalls.some(x=>/browserStart|openLogin|login$/.test(x))'))
print(json.dumps({'passed':len(checks),'checks':checks},ensure_ascii=False,indent=2))
