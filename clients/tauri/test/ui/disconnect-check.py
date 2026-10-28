"""Offline UI regression using serve.mjs synthetic data, never a user runtime."""
import json, subprocess, time
from pathlib import Path
out=Path('artifacts/disconnect-review');out.mkdir(parents=True,exist_ok=True)
checks=[]
def ab(*args):
 r=subprocess.run(['agent-browser','--session','pibo-disconnect-final','--json',*args],capture_output=True,text=True)
 if r.returncode: raise RuntimeError(r.stderr or r.stdout)
 d=json.loads(r.stdout);assert d['success'],d
 return d.get('data',{})
def js(code):return ab('eval',code).get('result')
def check(name,value):
 checks.append({'check':name,'pass':bool(value)});(out/'checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2));assert value,name
 print('PASS '+name,flush=True)
def wait():time.sleep(.3)
def until(code,seconds=15):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if js(code):return
  time.sleep(.3)
 raise AssertionError('Readiness deadline: '+code)
def click(name):
 if name=='连接':ab('click','.runtime-card-footer button')
 else:ab('find','role','button','click','--name',name)
 wait()
def openq(q):
 ab('open','http://127.0.0.1:5193/clients/tauri/test/ui/index.html?'+q);ab('wait','.app,.connection-landing');wait()
def shot(name):
 if name=='01-offline-chat-phone.png' and (out/name).exists():return # Already delivered; keep its Library identity.
 ab('screenshot',str(out/name))
def chat():
 ab('wait','[aria-label="灵感搭子 · 演示"]');click('灵感搭子 · 演示');assert js('document.querySelector(".app").dataset.phonePage==="chat"'),'Chat route did not open'
def drop():js('window.__PIBO_TEST__.active=null');time.sleep(2.2)
def visible_notice():return "[...document.querySelectorAll('.connection-feedback')].find(e=>e.getBoundingClientRect().width>0)"
q='phone=1&connected=1&returning=1&models=1&story=1'
ab('set','viewport','393','852');openq(q);chat();time.sleep(3.6)
ab('fill','[aria-label="消息"]','离线仍保留的草稿\n下一步继续整理。');ab('press','Tab');wait()
js('window.__qaApp=document.querySelector(".app");window.__qaRoute=location.hash;window.__qaMessageCount=document.querySelectorAll("[data-message-id]").length')
drop()
check('Transport loss keeps the same app and chat route',js('window.__qaApp===document.querySelector(".app")&&window.__qaRoute===location.hash'))
check('Messages and multiline draft survive disconnect',js('window.__qaMessageCount===document.querySelectorAll("[data-message-id]").length&&document.querySelector("[aria-label=消息]").value.includes("离线仍保留")'))
check('Offline notice is at most 48px, no recovery landing',js(f'{visible_notice()}.getBoundingClientRect().height<=48&&!document.querySelector(".runtime-restoring")'))
check('Compact rounded status shares the title without a full-width banner',js(f'{visible_notice()}.parentElement.classList.contains("header")&&parseFloat(getComputedStyle({visible_notice()},"::before").borderRadius)>=10&&{visible_notice()}.getBoundingClientRect().width<160'))
check('Offline send is disabled',js('document.querySelector(".send-button").disabled'))
shot('01-offline-chat-phone.png')
click('打开会话详情');ab('press','Escape');wait()
check('Details closes without losing offline chat',js('location.hash===window.__qaRoute'))
click('连接设置');check('Configure opens workspace tab only on request',js('document.querySelector("[role=tab][data-state=active]").textContent.includes("工作空间")'));shot('02-configure-on-request.png');click('关闭设置')
check('Closing configuration restores same chat and draft',js('window.__qaApp===document.querySelector(".app")&&document.querySelector("[aria-label=消息]").value.includes("离线仍保留")'))
click('返回会话列表');check('Offline conversation navigation remains available',js('!!document.querySelector("[aria-label=\\"灵感搭子 · 演示\\"]")'));shot('03-offline-conversations.png');chat()
# Duplicate clicks must make one runtime connection attempt; failure remains stable.
click('连接设置');js('(()=>{const b=[...document.querySelectorAll("[role=dialog] button")].find(e=>e.textContent==="连接");b.click();b.click()})()');time.sleep(1.8)
check('Repeated reconnect clicks issue one attempt',js('window.__PIBO_TEST__.connectAttempts')==1)
time.sleep(2.2);check('Failure does not start a retry loop',js('window.__PIBO_TEST__.connectAttempts')==1)
click('关闭设置');check('Failed retry keeps messages and draft',js('window.__qaMessageCount===document.querySelectorAll("[data-message-id]").length&&document.querySelector("[aria-label=消息]").value.includes("离线仍保留")'))
js('window.__PIBO_TEST__.connectSucceeds=true');click('连接设置');click('连接');until('window.__PIBO_TEST__.active!==null');click('关闭设置')
check('Same workspace reconnect preserves component and draft',js('window.__qaApp===document.querySelector(".app")&&document.querySelector("[aria-label=消息]").value.includes("离线仍保留")'))
until('!document.querySelector(".send-button").disabled');check('Successful reconnect enables sending',js('!document.querySelector(".send-button").disabled'))
# Switch runtime through Settings, keeping the QA endpoint isolated.
js('window.__PIBO_TEST__.profiles.push({id:"other",name:"另一演示工作空间",mode:"direct",url:"https://other.example.invalid/",dataDir:""})');time.sleep(2.2)
click('返回会话列表');click('设置');ab('find','role','tab','click','--name','工作空间');wait()
js('window.__PIBO_TEST__.emptySnapshot=true;[...document.querySelectorAll(".runtime-card")].find(e=>e.textContent.includes("另一演示工作空间")).querySelector(".runtime-card-footer button").click()');time.sleep(1.9);click('关闭设置')
check('Settings runtime switch clears previous conversations',js('window.__PIBO_TEST__.active.profileId==="other"&&window.__qaApp!==document.querySelector(".app")&&!document.body.textContent.includes("帮我整理一下今天的灵感")'))
check('Different workspace does not inherit draft',js('!document.querySelector("[aria-label=消息]")?.value.includes("离线仍保留")'))
# Cold start failure is a normal list shell, with no invented cached history.
openq('phone=1&returning=1&restore=1');time.sleep(1.8)
check('Cold restore failure leaves compact empty conversation shell',js('!!document.querySelector(".app")&&!document.querySelector(".connection-landing")&&!document.querySelector(".runtime-restoring")'))
check('Failure shows only connection-failed label and one Settings action',js(f'{visible_notice()}.textContent==="连接失败·设置"&&{visible_notice()}.querySelectorAll("button").length===1'))
shot('04-cold-start-offline.png');click('连接设置');click('关闭设置')
openq('phone=1&returning=1&restore=1&slow=1&success=1');check('Loading is a small inline indicator',js(f'{visible_notice()}.textContent==="连接中…·设置"'));shot('08-loading.png');click('连接设置');click('取消连接');click('关闭设置');time.sleep(5.2)
check('Cancelled restore cannot activate after late response',js('window.__PIBO_TEST__.active===null'))
check('Cancel preserves navigation and Settings entry',js('!!document.querySelector(".app")&&!!document.querySelector("[aria-label=连接设置]")'))
# First-time setup stays available and its form remains explicit.
openq('phone=1');check('First run offers Settings without a landing panel',js('!!document.querySelector(".app")&&!document.querySelector(".connection-landing")'));check('No runtime is not called a failure, with no duplicate empty-state copy',js(f'{visible_notice()}.textContent==="未连接·设置"&&!document.body.textContent.includes("连接后查看会话")&&!document.body.textContent.includes("会话仍保存在")'));click('连接设置');click('添加连接');check('First run opens connection form in Settings',js('!!document.querySelector("[role=dialog] .direct-connect")'));shot('05-first-runtime-setup.png');click('取消并返回');click('关闭设置');check('First setup cancel returns to conversation shell',js('!!document.querySelector(".app")&&!document.querySelector("[role=dialog]")'))
# Layout: phone/narrow/landscape/keyboard-size; also exercise list and scrolling.
for w,h in [(320,568),(874,402),(874,192)]:
 ab('set','viewport',str(w),str(h));openq(q);chat();drop()
 check(f'Offline layout fits {w}x{h}',js('document.documentElement.scrollWidth<=innerWidth&&scrollY===0&&document.querySelector(".composer-shell").getBoundingClientRect().bottom<=innerHeight'))
 check(f'Offline actions stay visible {w}x{h}',js(f'{visible_notice()}.getBoundingClientRect().bottom<=innerHeight&&{visible_notice()}.querySelector("button").getBoundingClientRect().height>=44'))
 if h>250:
  check(f'Message area scroll remains enabled {w}x{h}',js('getComputedStyle(document.querySelector(".conversation")).overflowY==="auto"'))
 shot(f'06-offline-{w}x{h}.png');click('返回会话列表');check(f'Back works offline {w}x{h}',js('document.querySelector(".app").dataset.phonePage==="list"'))
ab('set','viewport','1280','900');openq('mac=1&connected=1&returning=1&story=1');chat();drop();shot('07-offline-desktop.png')
check('Desktop offline keeps titlebar and sidebar',js('document.querySelector(".header").getBoundingClientRect().top===0&&document.querySelector(".messenger-sidebar").getBoundingClientRect().width>0'))
click('连接设置');js('document.querySelector("[aria-label=关闭设置]").focus()');ab('press','Enter');wait()
check('Settings close still supports keyboard activation',js('!document.querySelector("[role=dialog]")'))
click('连接设置');ab('press','Escape');wait()
check('Settings Escape dismissal remains available',js('!document.querySelector("[role=dialog]")'))
print(json.dumps({'passed':len(checks),'checks':checks},ensure_ascii=False,indent=2))
